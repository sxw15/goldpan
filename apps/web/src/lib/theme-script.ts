/**
 * Inline script to set the theme attribute before first paint.
 * Must be rendered in <head> by the server layout to prevent FOUC.
 */
const STORAGE_KEY = 'theme';
const ATTRIBUTE = 'data-theme';

export const themeInitScript = `(function(){try{var t=localStorage.getItem('${STORAGE_KEY}');var r=t==='dark'?'dark':t==='light'?'light':window.matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light';document.documentElement.setAttribute('${ATTRIBUTE}',r)}catch(e){}})()`;
