try {
  const theme = localStorage.getItem('theme');
  document.documentElement.classList.toggle('dark', theme === 'dark' || (!theme && matchMedia('(prefers-color-scheme: dark)').matches));
} catch {}
