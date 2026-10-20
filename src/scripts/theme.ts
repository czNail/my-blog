const THEME = "neil-homepage:theme";
const LEGACY_THEME = "theme";

function getPreferTheme(): string {
  try {
    const saved = localStorage.getItem(THEME) || localStorage.getItem(LEGACY_THEME);
    if (saved === "light" || saved === "dark") return saved;
  } catch {}
  return "light";
}

let themeValue = window.theme?.getTheme() ?? getPreferTheme();

function reflectPreference(): void {
  document.documentElement.dataset.theme = themeValue;
  const button = document.querySelector("#theme-btn");
  const label = themeValue === "dark" ? "切换到浅色主题" : "切换到深色主题";
  button?.setAttribute("aria-label", label);
  button?.setAttribute("title", label);
  button?.setAttribute("aria-pressed", String(themeValue === "dark"));
  const background = themeValue === "dark" ? "#171f2c" : "#fdfdfd";
  document.querySelector("meta[name='theme-color']")?.setAttribute("content", background);
}

function setPreference(): void {
  try {
    localStorage.setItem(THEME, themeValue);
    localStorage.setItem(LEGACY_THEME, themeValue);
  } catch {}
  reflectPreference();
}

window.theme = {
  themeValue,
  setPreference,
  reflectPreference,
  getTheme: () => themeValue,
  setTheme: (value: string) => {
    if (value !== "light" && value !== "dark") return;
    themeValue = value;
    if (window.theme) window.theme.themeValue = value;
  },
};

function setThemeFeature(): void {
  themeValue = getPreferTheme();
  window.theme?.setTheme(themeValue);
  reflectPreference();
  const button = document.querySelector<HTMLButtonElement>("#theme-btn");
  if (!button || button.dataset.themeBound) return;
  button.dataset.themeBound = "true";
  button.addEventListener("click", () => {
    window.theme?.setTheme(themeValue === "light" ? "dark" : "light");
    setPreference();
  });
}

setThemeFeature();
document.addEventListener("astro:after-swap", setThemeFeature);

window.addEventListener("storage", event => {
  if (event.key !== THEME && event.key !== LEGACY_THEME) return;
  window.theme?.setTheme(getPreferTheme());
  reflectPreference();
});

document.addEventListener("astro:before-swap", event => {
  event.newDocument.documentElement.dataset.theme = themeValue;
  event.newDocument.querySelector("meta[name='theme-color']")?.setAttribute(
    "content", themeValue === "dark" ? "#171f2c" : "#fdfdfd"
  );
});
