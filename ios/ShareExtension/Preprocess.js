// Run by Safari on the page being shared (NSExtensionJavaScriptPreprocessingFile): what the page is,
// and what the person selected on it. Nothing else is read, and nothing is sent anywhere from here.
var Preprocess = function () {};
Preprocess.prototype = {
  run: function (args) {
    var selection = "";
    try { selection = String(window.getSelection ? window.getSelection() : ""); } catch (e) {}
    args.completionFunction({ url: document.URL, title: document.title, selection: selection.slice(0, 20000) });
  },
  finalize: function () {}
};
var ExtensionPreprocessingJS = new Preprocess();
