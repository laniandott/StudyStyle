(() => { const v = (window.__VIEW__ || 'today'); const btn = document.querySelector(`[data-view="${v}"]`); if (btn) btn.click(); return 'view=' + v; })()
