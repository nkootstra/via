// The pre-paint half of the theme: plain strings, with no React, so the Vite
// plugin that inlines the script into a page can import it.

export const STORAGE_KEY = "via.theme";

/**
 * Applies a stored choice before the first paint. The page's shell inlines
 * it at the top of `<head>`, so it runs before the stylesheet paints and
 * before any module loads. It stays static, so its hash can go in the CSP.
 */
export const themeScript = `try{var t=localStorage.getItem("${STORAGE_KEY}");if(t==="light"||t==="dark"){var d=document.documentElement;d.dataset.theme=t;d.style.colorScheme=t}}catch(e){}`;

/** The CSP source that allows `themeScript` inline: `script-src 'self' <this>`. */
export const themeScriptHash = "sha256-xT7GS160ADjcqYmfRW8M5c93qSG8vRpFJ75/PAgpLG8=";
