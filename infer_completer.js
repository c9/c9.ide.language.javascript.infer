var globalRequire = require;

define(function(require, exports, module) {

var baseLanguageHandler = require('plugins/c9.ide.language/base_handler');
var infer = require('./infer');
var path = require('./path');
var ValueCollection = require('./values').ValueCollection;
var KIND_DEFAULT = require('plugins/c9.ide.language.javascript/scope_analyzer').KIND_DEFAULT;
var KIND_PACKAGE = require('plugins/c9.ide.language.javascript/scope_analyzer').KIND_PACKAGE;
var KIND_EVENT = require('plugins/c9.ide.language.javascript/scope_analyzer').KIND_EVENT;
var EXPAND_STRING = 1;
var EXPAND_REQUIRE = 2;
var EXPAND_REQUIRE_LIMIT = 5;
var REQUIRE_PROPOSALS_MAX = 80;
var REQUIRE_ID_REGEX = /(?!["'])./;
var FunctionValue = require('./values').FunctionValue;
var completeUtil = require("plugins/c9.ide.language.generic/complete_util");
var traverse = require("treehugger/traverse");
var tree = require("treehugger/tree");

// Completion priority levels
// Should be used sparingly, since they disrupt the sorting order
var PRIORITY_INFER_LOW = 3;
var PRIORITY_INFER = 4;
var PRIORITY_INFER_HIGH = 5;

var completer = module.exports = Object.create(baseLanguageHandler);
    
completer.handlesLanguage = function(language) {
    return language === 'javascript';
};

completer.getIdentifierRegex = function() {
    // Allow slashes for package names
    return (/[a-zA-Z_0-9\$\/]/);
};

completer.getCompletionRegex = function() {
    return (/[\.]/);
};

function valueCollToClosure(name, coll) {
    var result;
    coll.forEach(function(v) {
        if (result)
            return;
        if (v instanceof FunctionValue) {
            var args = [];
            var fargs = v.getFargs();
            var argColl = extractArgumentValues(v, fargs, idx);
            for(var idx = 0; !argColl.isEmpty() || idx < fargs.length; idx++) {
                var argName;
                if (fargs[idx])
                    argName =  fargs[idx].id || fargs[idx];
                else
                    argName = "arg" + idx;
                args.push(argName);
                argColl = extractArgumentValues(v, fargs, idx + 1);
            }
            result = "function(" + args.join(", ") + ") {\n    ^^\n}";
        }
    });
    return result;
}

function fargToClosure(farg) {
    if (!farg || !farg.fargs)
        return null;
    var args = [];
    for (var i = 0; i < farg.fargs.length; i++) {
        args.push(farg.fargs[i].id || farg.fargs[i]);
    }
    return "function(" + args.join(", ") + ") {\n    ^^\n}";
}

function extractArgumentNames(v, showOptionals) {
    var args = [];
    var argsCode = [];
    var inferredArguments = false;
    var opt = false;
    var fargs = v instanceof FunctionValue ? v.getFargs() : [];
    var argColl = extractArgumentValues(v, fargs, 0);
    for (var idx = 0; !argColl.isEmpty(); idx++) {
        var argName;
        if (fargs[idx]) {
            argName =  fargs[idx].id || fargs[idx];
            if (showOptionals && fargs[idx].opt) {
                argName = "[" + argName + "]";
                opt = true;
            }
        }
        else {
            argName = "arg" + idx;
            inferredArguments = true;
        }
        args.push(argName);
        argsCode.push(fargToClosure(fargs[idx]) || valueCollToClosure(argName, argColl));
        argColl = extractArgumentValues(v, fargs, idx + 1);
    }
    return {
        argNames: args,
        argValueCodes: argsCode,
        inferredNames: inferredArguments,
        opt: opt
    };
}

function extractArgumentValues(v, fargs, index) {
    var result;
    if (fargs[index] && fargs[index].id) {
        result = new ValueCollection();
        if (fargs[index].type)
            result.extend(fargs[index].type);
    }
    else {
        result = v.get("arg" + index);
    }
    return result;
}

function valueToMatch(container, v, name, isPackage) {
    // Node.js and the default behavior of require.js is not adding the .js extension
    if (isPackage)
        name = name.replace(/\.js$/, "");
    if ((v instanceof FunctionValue || v.properties._return) && !isPackage) {
        var showArgs = extractArgumentNames(v, true);
        var insertArgs = showArgs.opt ? extractArgumentNames(v, false) : showArgs;
        return {
            id           : name,
            guid         : v.guid + "[0" + name + "]",
            name         : name + "(" + showArgs.argNames.join(", ") + ")",
            replaceText  : name + (insertArgs.argNames.length === 0 && v.guid && v.guid.indexOf("es5:") !== 0 ? "()" : "(^^)"),
            icon         : "method",
            priority     : PRIORITY_INFER,
            inferredNames: showArgs.inferredNames,
            doc          : v.doc,
            docUrl       : v.docUrl,
            isFunction   : true,
            type         : v.properties._return && getGuid(v.properties._return.values[0])
        };
    }
    else {
        return {
            id          : name,
            guid        : container ? container.guid + "/" + name : v.guid + "[0" + name + "]",
            name        : name,
            replaceText : name,
            doc         : v.doc,
            docUrl      : v.docUrl,
            icon        : "property",
            priority    : name === "__proto__" ? PRIORITY_INFER_LOW : PRIORITY_INFER,
            type        : !isPackage && getGuid(v.properties.___proto__ ? v.properties.___proto__.values[0] : v.guid)
        };
    }
}

function getGuid(valueOrGuid) {
    if (!valueOrGuid)
        return;
    var result = valueOrGuid.guid || valueOrGuid;
    return result.substr && result.substr(-11) !== "/implReturn" ? result : undefined;
}

completer.complete = function(doc, fullAst, pos, currentNode, callback) {
    if (!currentNode)
        return callback();
    var line = doc.getLine(pos.row);
    var identifier = completeUtil.retrievePrecedingIdentifier(line, pos.column, completer.getIdentifierRegex());
    var basePath = path.getBasePath(completer.path, completer.workspaceDir);
    var filePath = path.canonicalizePath(completer.path, basePath);
    if (fullAst.parent === undefined) {
        traverse.addParentPointers(fullAst);
        fullAst.parent = null;
    }
    infer.analyze(doc, fullAst, filePath, basePath, function() {
        var completions = {};
        var duplicates = {};
        currentNode.rewrite(
            'PropAccess(e, x)', function(b) {
                var allIdentifiers = [];
                var values = infer.inferValues(b.e);
                values.forEach(function(v) {
                    var propNames = v.getPropertyNames();
                    for (var i = 0; i < propNames.length; i++) {
                        if (propNames[i] !== b.x.value || v.isProperDeclaration(propNames[i]))
                            allIdentifiers.push(propNames[i]);
                    }
                });
                var matches = completeUtil.findCompletions(identifier, allIdentifiers);
                for (var i = 0; i < matches.length; i++) {
                    values.forEach(function(v) {
                        v.get(matches[i]).forEach(function(propVal) {
                            var match = valueToMatch(v, propVal, matches[i]);
                            // Only override completion if argument names were _not_ inferred, or if no better match is known
                            var duplicate = duplicates["_"+match.id];
                            if (duplicate && duplicate.inferredNames)
                                delete completions["_"+duplicate.guid];
                            if (duplicate && match.inferredNames)
                                return;
                            duplicates["_"+match.id] = completions["_" + match.guid] = match;
                        });
                    });
                }
                return this;
            },
            // Don't complete definitions
            'FArg(_)', 'Function(_,_,_)', 'VarDeclInit(_,_)', 'VarDecl(_,_)',
            'ConstDeclInit(_,_)', 'ConstDecl(_,_)', function() { return this; },
            '_', function() {
                var me = this;
                if (this.traverseUp(
                    "Call(Var(\"require\"), args)",
                    function(b) {
                        if (b.args[0] !== me && this !== me)
                            return;
                        var scope = this[0].getAnnotation("scope");
                        var expand = b.args[0] && b.args[0].cons === "String" ? null : EXPAND_STRING;
                        identifier = completeUtil.retrievePrecedingIdentifier(line, pos.column, REQUIRE_ID_REGEX);

                        var useBasePath = path.isRelativePath(identifier) || path.isAbsolutePath(identifier) ? basePath : null;
                        completer.proposeRequire(identifier, expand, scope, completions, useBasePath);
                    }))
                    return this;
            },
            'ERROR()', 'PropertyInit(x,e)', 'ObjectInit(ps)', function(b, node) {
                if (b.ps) {
                    completer.proposeObjectProperty(node, identifier, completions);
                }
                else if (!b.x) {
                    if (currentNode.parent.cons !== "PropertyInit")
                        return; // Fallthrough
                    currentNode = currentNode.parent;
                    b.x = currentNode[0];
                    b.e = currentNode[1];
                }
                // get parent parent like in ObjectInit([PropertyInit("b",ERROR())])
                var objectInit = currentNode.parent.parent;
                if (!objectInit.parent || !objectInit.parent.parent || !objectInit.parent.parent.cons === "Call")
                    return node;
                completer.proposeObjectProperty(objectInit, identifier, completions);
                return node;
            },
            'Call(_, _)', function(b) {
                completer.proposeClosure(this, doc, pos, completions);
                // Fallthrough to next rule
            },
            'Var(_)', function(b) {
                if (this.parent.parent && this.parent.parent.isMatch('Call(_, _)') && "function".indexOf(identifier) === 0)
                    completer.proposeClosure(this.parent.parent, doc, pos, completions);
                // Fallthrough to next rule
            },
            'Var(_)', function(b) {
                this.parent.rewrite('VarDeclInit(x, _)', 'ConstDeclInit(x, _)', function(b) {
                    if ("require".indexOf(identifier) !== 0)
                        return;
                    var scope = this.getAnnotation("scope");
                    // Propose relative and non-relative paths
                    completer.proposeRequire(b.x.value, EXPAND_REQUIRE, scope, completions);
                    completer.proposeRequire(b.x.value, EXPAND_REQUIRE, scope, completions, basePath);
                });
                // Fallthrough to next rule
            },
            // Else, let's assume it's a variable
            function() {
                var scope;
                this.traverseUp(function() {
                    if (!scope) scope = this.getAnnotation("scope");
                    if (this.rewrite("String(_)")) return this;
                });
                if (!scope)
                    return;
                var variableNames = scope.getVariableNames();
                if (this.cons === 'Var') { // Delete current var from proposals if not properly declared anywhere
                    var varName = this[0].value;
                    if(variableNames.indexOf(varName) !== -1 && !scope.get(varName).isProperDeclaration())
                        variableNames.splice(variableNames.indexOf(varName), 1);
                }
                var matches = completeUtil.findCompletions(identifier, variableNames);
                for (var i = 0; i < matches.length; i++) {
                    var v = scope.get(matches[i]);
                    v.values.forEach(function(propVal) {
                        var match = valueToMatch(null, propVal, matches[i]);
                        if (!match.name)
                            return;
                        // Only override completion if argument names were _not_ inferred, or if no better match is known
                        var duplicate = duplicates["_"+match.id];
                        if (duplicate && duplicate.inferredNames)
                            delete completions["_"+duplicate.guid];
                        if (duplicate && match.inferredNames)
                            return;
                        duplicates["_"+match.id] = completions["_"+match.guid] = match;
                    });
                }
            }
        );
        // Find completions equal to the current prefix
        var completionsArray = [];
        for (var id in completions) {
            completionsArray.push(completions[id]);
        }
        callback(completionsArray);
    });
};

/**
 * @param basePath  If specified, the base path to use for relative paths.
 *                  Enables listing relative paths.
 */
completer.proposeRequire = function(identifier, expand, scope, completions, basePath) {
    var names = scope.getNamesByKind(KIND_PACKAGE);
    
    if (basePath || basePath === "")
        identifier = path.canonicalizePath(identifier, basePath).replace(/^\.$/, "");
    
    var matches = expand === EXPAND_REQUIRE
        ? filterRequireSubstring(identifier, names)
        : completeUtil.findCompletions(identifier === "/" ? "" : identifier, names);
    
    if (basePath || basePath === "")
        matches = matches.filter(function(v) { return v.match(/\.js$/) && !v.match(/(\/|^)node_modules\//); });
    else
        matches = matches.filter(function(v) { return !v.match(/\.js$/); });
    
    if (expand === EXPAND_REQUIRE && matches.length > EXPAND_REQUIRE_LIMIT)
        return;

    matches = matches.slice(0, REQUIRE_PROPOSALS_MAX);

    for (var i = 0; i < matches.length; i++) {
        var v = scope.get(matches[i], KIND_PACKAGE);
        v.values.forEach(function(propVal) {
            var match = valueToMatch(null, propVal, matches[i], true, expand);
            match.icon = "package";
            if (identifier.match(/^\//))
                match.replaceText = match.name = "/" + match.replaceText;
            else if (basePath || basePath === "")
                match.replaceText = match.name = path.uncanonicalizePath(match.replaceText, basePath);
            completions["_"+match.guid] = match;
            if (expand === EXPAND_REQUIRE) {
                match.replaceText = 'require("' + match.replaceText + '")';
                match.name = 'require("' + match.name + '")';
            }
            if (expand === EXPAND_STRING)
                match.replaceText = '"' + match.replaceText + '"';
            if (expand !== EXPAND_REQUIRE)
                match.identifierRegex = REQUIRE_ID_REGEX;
        });
    }
};

completer.proposeClosure = function(node, doc, pos, completions) {
    node.rewrite('Call(f, args)', function(b) {
        var argIndex = completer.getArgIndex(this, doc, pos);
        var id = 0;
        infer.inferValues(b.f).forEach(function(v) {
            var argNames = extractArgumentNames(v, false);
            var code = argNames.argValueCodes[argIndex];
            if (!code)
                return;
            var codeName = code.split(/\n/)[0] + "}";
            var guid = v.guid + "-argfun" + (id++);
            completions[guid] = {
                id          : codeName,
                guid        : guid,
                name        : codeName,
                replaceText : code,
                doc         : v.fargs && v.fargs.doc,
                docUrl      : v.fargs && v.fargs.docUrl,
                icon        : "method",
                priority    : PRIORITY_INFER_HIGH
            };
        });
    });
};

/**
 * Complete properties for an Object init in e.g.
 * Call(PropAccess(Var("http"),"example"),[ObjectInit([PropertyInit("b",ERROR())])])
 */    
completer.proposeObjectProperty = function(objectInit, identifier, completions) {
    var listIndex;
    for (var i = 0; i < objectInit.parent.length; i++)
        if (objectInit.parent[i] === objectInit) listIndex = i;
    var call = objectInit.parent.parent;
    infer.inferValues(call[0]).forEach(function(v) {
        if (!v.fargs || !v.fargs[listIndex] || !v.fargs[listIndex].properties)
            return;
        v.fargs[listIndex].properties.forEach(function(property) {
            completions["_$p$" + property.id] = {
                id:          property.id,
                name:        property.id,
                replaceText: property.id,
                doc:         property.doc,
                docUrl:      property.docUrl,
                icon:        "property",
                priority:    PRIORITY_INFER
            };
        });
    });
};

function filterRequireSubstring(name, names) {
    var nameClean = name.replace(/[^A-Za-z0-9_-]/g, ".");
    var nameRegex = new RegExp("^" + nameClean + "\\b|\\b" + nameClean + "$");
    return names.filter(function(n) {
        return nameRegex.test(n);
    })
}

completer.onCursorMovedNode = function(doc, fullAst, cursorPos, currentNode, callback) {
    if(!currentNode)
        return callback();
    if(fullAst.parent === undefined) {
        traverse.addParentPointers(fullAst);
        fullAst.parent = null;
    }
    var steps = 0;
    var argIndex = -1;
    
    var callNode;
    var argPos;
    currentNode.traverseUp(
        'Call(e, args)', function(b) {
            callNode = this;
            argPos = { row: b.args.getPos().sl, column: b.args.getPos().sc }; 
            if (argPos.row >= 9999999999)
                argPos = cursorPos;
        },
        function() {
            steps++;
            var pos = this.getPos();
            if (pos && (pos.sl !== cursorPos.row || cursorPos.row !== pos.el))
                return this;
        }
    );
    if (!callNode) {
        callback();
        return;
    }
    argIndex = this.getArgIndex(callNode, doc, cursorPos);
    
    if (argIndex !== -1) {
        var basePath = path.getBasePath(completer.path, completer.workspaceDir);
        var filePath = path.canonicalizePath(completer.path, basePath);
        infer.analyze(doc, fullAst, filePath, basePath, function() {
            var fnVals = infer.inferValues(callNode[0]);
            var argNames = [];
            var opt = false;
            fnVals.forEach(function(fnVal) {
                var argNameObj = extractArgumentNames(fnVal, true);
                if (argNameObj.inferredNames || argNameObj.argNames.length <= argIndex)
                    return;
                argNames.push(argNameObj.argNames);
                opt = opt || argNameObj.opt;
            });
            
            var hintHtml = '';
            for (var i = 0; i < argNames.length; i++) {
                var curArgNames = argNames[i];
                for (var j = 0; j < curArgNames.length; j++) {
                    if(j === argIndex && !opt && argNames.length === 1)
                        hintHtml += "<b>" + curArgNames[j] + "</b>";
                    else
                        hintHtml += curArgNames[j];
                    if(j < curArgNames.length - 1)
                        hintHtml += ", ";
                }
                if(i < argNames.length - 1)
                    hintHtml += "<br />";
            }
            callback({ hint: hintHtml, displayPos: argPos });
        });
    }
    else
        callback();
};

/**
 * Gets the index of the selected function argument, or returns -1 if N/A.
 */
completer.getArgIndex = function(node, doc, cursorPos) {
    var cursorTreePos = { line: cursorPos.row, col: cursorPos.column };
    var result = -1;
    node.rewrite(
        'Call(e, args)', function(b) {
            // Try to determine at which argument the cursor is located in order
            // to be able to show a label
            result = -1;
            var line = doc.getLine(cursorPos.row);
            if (line[b.args.getPos().ec + 1] && line[b.args.getPos().ec + 1].match(/[ ,]/))
                b.args.getPos().ec++;

            if (b.args.length === 0 && this.getPos().ec - 1 === cursorPos.column) {
                result = 0;
            }
            else if (b.args.length === 0 && line.substr(cursorPos.column - 1, 2) === "()") {
                result = 0;
            }
            else if (!tree.inRange(b.args.getPos(), cursorTreePos, true)) {
                return this;
            }
            for (var i = 0; i < b.args.length; i++) {
                if(b.args[i].cons === "ERROR" && result === -1) {
                    result = i;
                    break;
                }
                b.args[i].traverseTopDown(function() {
                    var pos = this.getPos();
                    if (this === node) {
                        result = i;
                        return this;
                    }
                    else if (pos && cursorPos.row >= pos.sl && cursorPos.column >= pos.ec) {
                        result = i === b.args.length - 1 ? i : i + 1;
                    }
                });
            }
            return this;
        }
    );
    return result;
};

});
