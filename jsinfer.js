/**
 * Inference-based code completion for the Cloud9 IDE
 *
 * @copyright 2010, Ajax.org B.V.
 * @license GPLv3 <http://www.gnu.org/licenses/gpl.txt>
 */
define(function(require, exports, module) {
    main.consumes = [
        "Plugin", "language", "language.complete"
    ];
    main.provides = [];
    return main;

    function main(options, imports, register) {
        var language = imports.language;
        
        language.registerLanguageHandler('plugins/c9.ide.language.javascript.infer/infer_jumptodef');
        language.registerLanguageHandler('plugins/c9.ide.language.javascript.infer/infer_tooltip');
        language.registerLanguageHandler('plugins/c9.ide.language.javascript.infer/infer_completer', function() {
            console.log("c9.ide.language started");
        });
        register(null, {});
    }

});
