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

handler.onCursorMovedNode = function(doc, fullAst, cursorPos, currentNode, callback) {
    if (!currentNode)
        return callback();
    if (fullAst.parent === undefined) {
        traverse.addParentPointers(fullAst);
        fullAst.parent = null;
    }
    var argIndex = -1;
    
    var callNode = getCallNode(currentNode, cursorPos);
    if (!callNode)
        return callback();
        
    var argPos = { row: callNode[1].getPos().sl, column: callNode[1].getPos().sc }; 
    if (argPos.row >= 9999999999)
        argPos = cursorPos;
    
    argIndex = this.getArgIndex(callNode, doc, cursorPos);
    
    if (argIndex !== -1) {
        var basePath = path.getBasePath(handler.path, handler.workspaceDir);
        var filePath = path.canonicalizePath(handler.path, basePath);
        astUpdater.updateOrReanalyze(doc, fullAst, filePath, basePath, cursorPos, function(fullAst, currentNode) {
            callNode = getCallNode(currentNode, cursorPos); // get analyzed callNode
            var fnVals = infer.inferValues(callNode[0]);
            var argNames = [];
            var opt = Number.MAX_VALUE;
            fnVals.forEach(function(fnVal, i) {
                var argNameObj = extractArgumentNames(fnVal, true);
                if (argNameObj.inferredNames || argNameObj.argNames.length <= argIndex)
                    return;
                argNames.push(argNameObj.argNames);
                if ("opt" in argNameObj && opt < argNames.length - 1)
                    opt = Math.min(opt, i);
            });
            
            var hintHtml = '';
            for (var i = 0; i < argNames.length; i++) {
                var curArgNames = argNames[i];
                for (var j = 0; j < curArgNames.length; j++) {
                    if (j === argIndex && j < opt && argNames.length === 1)
                        hintHtml += "<b>" + curArgNames[j] + "</b>";
                    else
                        hintHtml += curArgNames[j];
                    if (j < curArgNames.length - 1)
                        hintHtml += ", ";
                }
                if (i < argNames.length - 1)
                    hintHtml += "<br />";
            }
            callback({ hint: hintHtml, displayPos: argPos });
        });
    }
    else
        callback();
};

function getCallNode(currentNode, cursorPos) {
    var result;
    currentNode.traverseUp(
        'Call(e, args)', function(b, node) {
            result = node;
            return node;
        },
        function(node) {
            var pos = node.getPos();
            if (pos && (pos.sl !== cursorPos.row || cursorPos.row !== pos.el))
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
            else if (b.args.length === 0 && line.substr(cursorPos.column -1).match(/\(\s*\)/)) {
                result = 0;
            }
            else if (!tree.inRange(this.getPos(), cursorTreePos, true)) {
                return this;
            }
            else if (line.substr(0, cursorPos.column + 1).match(/,\s*\)$/)) {
                result = b.args.length;
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
                    else if (pos && pos.sl <= cursorPos.row && pos.sc <= cursorPos.column) {
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
    var inferredArguments = false;
    var opt;
    var fargs = v instanceof FunctionValue ? v.getFargs() : [];
    var argColl = extractArgumentValues(v, fargs, 0);
    for (var idx = 0; !argColl.isEmpty(); idx++) {
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
