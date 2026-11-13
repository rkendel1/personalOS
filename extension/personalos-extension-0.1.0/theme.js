// Applies the saved theme before the app renders, so there is no light flash in dark mode.
// The shared stack-ui preference (key "stack-ui.theme", attribute data-stack-theme; see
// src/theme.tsx), falling back to the key PersonalOS used before. A file, not an inline script,
// so it also works under a Content-Security-Policy that allows only same-origin scripts.
try {
  var theme = localStorage.getItem("stack-ui.theme") || localStorage.getItem("app:theme");
  if (theme === "light" || theme === "dark") document.documentElement.setAttribute("data-stack-theme", theme);
} catch (e) {}
