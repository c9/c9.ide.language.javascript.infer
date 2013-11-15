var globalRequire = require;

define(function(require, exports, module) {

var baseLanguageHandler = require('plugins/c9.ide.language/base_handler');
var infer = require('./infer');
var path = require('./path');
var tree = require("treehugger/tree");
var traverse = require("treehugger/traverse");
var FunctionValue = require('./values').FunctionValue;
var ValueCollection = require('./values').ValueCollection;
var astUpdater = require("./ast_updater");

var handler = module.exports = Object.create(baseLanguageHandler);
    
handler.handlesLanguage = function(language) {
    return language === 'javascript';
};

handler.handlesEditor = function() {
    return this.HANDLES_ANY;
};

handler.tooltip = function(doc, fullAst, cursorPos, currentNode, callback) {
    if (!currentNode)
        return callback();
    if (fullAst.parent === undefined) {
        traverse.addParentPointers(fullAst);
        fullAst.parent = null;
    }
    var argIndex = -1;
    
    var callNode = getCallNode(currentNode, cursorPos);
    var displayPos;
    var argIndex;
    
    if (callNode) {
        var argPos = { row: callNode[1].getPos().sl, column: callNode[1].getPos().sc }; 
        if (argPos.row >= 9999999999)
            argPos = cursorPos;
      
        displayPos = argPos;
        argIndex = this.getArgIndex(callNode, doc, cursorPos);
    }
    else if (currentNode.isMatch('Var(_)')) {
        displayPos = { row: currentNode.getPos().sl, column: currentNode.getPos().sc };
        argIndex = -1;
        // Don't display tooltip at end of identifier (may just have been typed in)
        if (cursorPos.column === currentNode.getPos().ec)
            return callback();
    }
    else {
        return callback();
    }
    
    if (argIndex !== -1 || !callNode) {
        var basePath = path.getBasePath(handler.path, handler.workspaceDir);
        var filePath = path.canonicalizePath(handler.path, basePath);
        astUpdater.updateOrReanalyze(doc, fullAst, filePath, basePath, cursorPos, function(fullAst, currentNode) {
            callNode = getCallNode(currentNode, cursorPos); // get analyzed ast's callNode
            var targetNode = callNode ? callNode[0] : currentNode;
            var rangeNode = callNode && callNode.getPos().sc < 99999 ? callNode : currentNode;
            var fnVals = infer.inferValues(targetNode);
            var fnName = targetNode.rewrite(
                "Var(x)", function(b) { return b.x.value; },
                "PropAccess(e, x)", function(b) { return b.x.value; },
                function() { return "function"; }
            );
            var argNames = [];
            var fnTypes = [];
            var argName;
            var argDoc;
            var opt = Number.MAX_VALUE;
            fnVals.forEach(function(fnVal, i) {
                var argNameObj = extractArgumentNames(fnVal, true);
                if (argNameObj.inferredNames)
                    return;
                fnName = fnName || fnVal.guid.match(/([^:\/\[]+)(\[[^\]]*\])?$/)[1];
                var myArgs = argNameObj.argNames.map(function(name, i) {
                    var type;
                    return fnVal.fargs && fnVal.fargs[i].type && (type = guidToShortString(fnVal.fargs[i].type))
                        ? name + ":" + type
                        : name;
                });
                if (containsArray(argNames, myArgs))
                    return;
                argNames.push(myArgs);
                if ("opt" in argNameObj && opt < argNames.length - 1)
                    opt = Math.min(opt, i);
                fnTypes.push(fnVal.properties && fnVal.properties._return && fnVal.properties._return[0]);
                argDoc = argDoc || fnVal.fargs && fnVal.fargs[argIndex] && fnVal.fargs[argIndex].doc;
                argName = argName || fnVal.fargs && fnVal.fargs[argIndex] && (fnVal.fargs[argIndex].id || fnVal.fargs[argIndex]);
            });
            
            var noTypeInfo = !fnTypes.length || fnTypes.length === 1 && !fnTypes[0];
            var noArgInfo = !argNames.length || (argNames.length === 1 && !argNames[0].length);
            
            // Quit if we have no useful info
            if (fnName === "function" || noTypeInfo && !argDoc && noArgInfo)
                return callback();
            
            var hintHtml = "";
            for (var i = 0; i < argNames.length; i++) {
                hintHtml += fnName + "(";
                var curArgNames = argNames[i];
                for (var j = 0; j < curArgNames.length; j++) {
                    if ((j === argIndex && j < opt))
                        hintHtml += '<span class="language_activeparam">' + curArgNames[j] + "</span>";
                    else
                        hintHtml += curArgNames[j];
                    if (j < curArgNames.length - 1)
                        hintHtml += ", ";
                }
                if (fnTypes[i])
                    hintHtml += " : " + fnTypes[i];
                hintHtml += ")";
                if (i < argNames.length - 1)
                    hintHtml += "<br />";
            }
            if (argDoc)
                hintHtml +=
                    '<div class="language_paramhelp">'
                    // + '<span class="language_activeparamindent">' + fnName + '(</span>'
                    + '<span class="language_activeparam">' + argName + '</span>:'
                    + '<span class="language_activeparamhelp">' + argDoc + '</span></div>'
            
            // TODO: support returning a json object instead?
            
            callback({
                hint: hintHtml,
                pos: {
                    sl: rangeNode.getPos().sl,
                    sc: rangeNode.getPos().sc,
                    el: rangeNode.getPos().el,
                    ec: rangeNode.getPos().ec,
                },
                displayPos: displayPos
            });
        });
    }
    else
        callback();
};

function containsArray(arrayArrays, array) {
    for (var i = 0; i < arrayArrays.length; i++) {
        if (arraysEqual(arrayArrays[i], array))
            return true;
    }
    return false;
}

function arraysEqual(a, b) {
  if (a.length !== b.length)
      return false;
  for (var i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
  }
  return true;
}

// TODO: merge with completedp.guidToShortString()
var guidToShortString = function(guid) {
    if (Array.isArray(guid))
        guid = guid[0];
    if (!guid)
        return;
    var result = guid.replace(/^[^:]+:(([^\/]+)\/)*?([^\/]*?)(\[\d+[^\]]*\])?(\/prototype)?$|.*/, "$3");
    return result && result !== "Object" ? result : "";
}

function getCallNode(currentNode, cursorPos) {
    var result;
    currentNode.traverseUp(
        'Call(e, args)', function(b, node) {
            result = node;
            return node;
        },
        function(node) {
            // Show tooltip only on first line if call spans multiple lines
            var pos = node.getPos();
            if (pos && pos.sl !== cursorPos.row)
                return node;
        }
    );
    return result;
}

/**
 * Gets the index of the selected function argument, or returns -1 if N/A.
 */
handler.getArgIndex = function(node, doc, cursorPos) {
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
            else if (b.args.length === 0 && line.substr(cursorPos.column).match(/^\s*\)/)) {
                result = 0;
            }
            else if (!tree.inRange(this.getPos(), cursorTreePos, true)) {
                return this;
            }
            else if (cursorPos.row === this.getPos().sl && line.substr(0, cursorPos.column + 1).match(/,\s*\)$/)) {
                result = b.args.length;
                return this;
            }
            for (var i = 0; i < b.args.length; i++) {
                if (b.args[i].cons === "ERROR" && result === -1) {
                    result = i;
                    break;
                }
                b.args[i].traverseTopDown(function() {
                    var pos = this.getPos();
                    if (this === node) {
                        result = i;
                        return this;
                    }
                    else if (pos && pos.sl <= cursorPos.row && pos.sc <= cursorPos.column) {
                        if (pos.sl === cursorPos.row && pos.ec === cursorPos.column - 1 && line[pos.ec] === ")")
                            return result = -1;
                        result = i;
                    }
                });
            }
            return this;
        }
    );
    return result;
};

var extractArgumentNames = handler.extractArgumentNames = function(v, showOptionals) {
    var args = [];
    var argsCode = [];
    var inferredArguments = v.callOnly;
    var opt;
    var fargs = v instanceof FunctionValue ? v.getFargs() : [];
    var argColl = extractArgumentValues(v, fargs, 0);
    for (var idx = 0; fargs.length ? idx < fargs.length : !argColl.isEmpty(); idx++) {
        var argName;
        if (fargs[idx]) {
            argName =  fargs[idx].id || fargs[idx];
            if (showOptionals && fargs[idx].opt) {
                argName = "[" + argName + "]";
                opt = opt || idx;
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
};

var extractArgumentValues = handler.extractArgumentValues = function(v, fargs, index) {
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
};

function fargToClosure(farg) {
    if (!farg || !farg.fargs)
        return null;
    var args = [];
    for (var i = 0; i < farg.fargs.length; i++) {
        args.push(farg.fargs[i].id || farg.fargs[i]);
    }
    return "function(" + args.join(", ") + ") {\n    ^^\n}";
}

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

});
