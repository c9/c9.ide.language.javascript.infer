define(function(require, exports, module) {

    var infer = require("./infer");
    var assert = require("plugins/c9.util/assert");
    var tree = require("treehugger/tree");
    
    var REGEX_SAFE_CHANGE = /^[\(\)\s\.\/\*+;A-Za-z-0-9_$]*$/;
    var REGEX_IDENTIFIER_PART = /[A-Za-z-0-9_$]*$/;
    
    var lastAST;
    var lastDocValue;
   
    /**
     * Attempts to reuse & update the previously analyzed AST,
     * or re-analyzes as needed, using infer.update().
     * 
     * @param callback
     * @param callback.ast The analyzed AST to use.
     */
    module.exports.updateOrReanalyze = function(doc, ast, filePath, basePath, pos, callback) {
        // Try with our last adapted AST
        var docValue = doc.getValue();
        var updatedAST = tryUpdateAST(doc, docValue, ast);
        if (updatedAST) {
            lastDocValue = docValue;
            lastAST = ast;
            console.log("[ast_updater] reused AST"); // DEBUG
            return callback(updatedAST, findNode(updatedAST, pos));
        }
        
        // Re-analyze instead
        return infer.analyze(doc, ast, filePath, basePath, function() {
            lastDocValue = docValue;
            lastAST = ast;
            callback(ast, findNode(ast, pos));
        }, true);
    };
   
    function tryUpdateAST(doc, docValue, ast) {
        if (lastDocValue === docValue)
            return lastAST;
        if (!isUpdateableAST(doc, docValue, ast))
            return null;
        
        assert(lastAST.annos.scope, "Source is empty");
        if (copyAnnosTop(lastAST, ast)) {
            assert(ast.annos.scope, "Target is empty");
            return ast;
        }
    }
    
    /**
     * Performs a simple, performant check to see if the
     * input is eligle for reusing the previous analysis.
     *
     * @returns {Boolean} true if the old AST may be reusable
     */
    function isUpdateableAST(doc, docValue, ast) {
        if (!lastDocValue)
            return false;

        var diff = getDiff(lastDocValue, docValue);
        
        return diff && diff.text.match(REGEX_SAFE_CHANGE);
    }
    
    function copyAnnosTop(oldAST, newAST) {
        copyAnnos(oldAST, newAST);
            
        for (var i = 0, j = 0; j < newAST.length; i++, j++) {
            if (!oldAST[i]) {
                if  (newAST[j].cons !== "Var")
                    return false;
                // Var(x) was just inserted
                copyAnnos(findScopeNode(oldAST), newAST[j]);
                if (!newAST[j].annos)
                    return false;
                continue;
            }
            if (oldAST[i].cons !== newAST[j].cons) {
                // Var(x) became PropAccess(Var(x), y)
                if (oldAST[i].cons === "Var" && newAST[j].isMatch("PropAccess(Var(_),_)")) {
                    copyAnnos(oldAST[i], newAST[j][0]);
                    continue;
                }
                // Call()
                if (oldAST[i].isMatch("PropAccess(Var(_),_)") && newAST[j].isMatch("Call(PropAccess(Var(_),_),_)")) {
                    copyAnnos(oldAST[i][0], newAST[j][0][0]);
                    var oldTemplate = new tree.ListNode([oldAST[i][0]]);
                    oldTemplate.parent = oldAST;
                    copyAnnosTop(oldTemplate, newAST[j][1])
                    continue;
                }
                // Var(x) was just inserted
                if (newAST[j].cons === "Var" && newAST[j+1] && newAST[j+1].cons === oldAST[i].cons) {
                    copyAnnos(findScopeNode(oldAST), newAST[j]);
                    if (!newAST[j].annos)
                        return false;
                    i--;
                    continue;
                }
                return false;
            }
            if (newAST[i].length)
                if (!copyAnnosTop(oldAST[i], newAST[j]))
                    return false;
            
        }
        return true;
    }
    
    function copyAnnos(oldNode, newNode) {
        if (!oldNode.annos)
            return;
        if (!newNode.annos)
            newNode.annos = {};
        for (var anno in oldNode.annos) {
            if (oldNode.annos.hasOwnProperty(anno) && anno !== "origin")
                newNode.annos[anno] = oldNode.annos[anno];
        }
    }
    
    function findScopeNode(ast) {
        if (!ast)
            return null;
        if (ast.annos.scope)
            return ast;
        return findScopeAnnos(ast.parent);
    }
    
    function getDiff(oldDoc, newDoc) {
        if (oldDoc.length > newDoc.length)
            return null;
        
        var diffLeft = -1;
        var diffRight = 0;
        
        for (var i = 0;  i < newDoc.length; i++) {
            if (oldDoc[i] !== newDoc[i]) {
                diffLeft = i;
                break;
            }
        }
        
        for (var i = newDoc.length, j = oldDoc.length; j >= 0; i--, j--) {
            if (oldDoc[j] !== newDoc[i]) {
                diffRight = i + 1;
                break;
            }
        }
        
        assert(diffLeft != -1, "Inputs can't be equal");
        
        return {
            start: diffLeft,
            end: diffRight,
            text: newDoc.substring(diffLeft, diffRight)
        };
    }
    
    function findNode(ast, pos) {
        var treePos = { line: pos.row, col: pos.column };
        return ast.findNode(treePos);
    }
    
    
});