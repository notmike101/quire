(() => {
    const preference = globalThis.matchMedia('(prefers-color-scheme: dark)');
    let savedTheme;

    try {
        savedTheme = globalThis.localStorage.getItem('quire-theme');
    } catch {
        // Storage can be disabled; theme selection still works for this visit.
    }

    if (savedTheme !== 'light' && savedTheme !== 'dark') {
        savedTheme = undefined;
    }

    /**
     * Apply the saved choice, or follow the current system preference.
     */
    function applyTheme() {
        const dark = savedTheme ? savedTheme === 'dark' : preference.matches;

        document.documentElement.dataset.theme = dark ? 'dark' : 'light';
        document.querySelector('meta[name="theme-color"]').content = dark ? '#111113' : '#f5f3ed';

        const select = document.querySelector('.theme-select');

        if (select) {
            select.value = savedTheme ?? 'system';
        }
    }

    applyTheme();
    preference.addEventListener('change', applyTheme);
    document.addEventListener('DOMContentLoaded', () => {
        const select = document.querySelector('.theme-select');

        document.querySelector('.theme-control').hidden = false;
        applyTheme();
        select.addEventListener('change', () => {
            savedTheme = select.value === 'system' ? undefined : select.value;

            try {
                if (savedTheme) {
                    globalThis.localStorage.setItem('quire-theme', savedTheme);
                } else {
                    globalThis.localStorage.removeItem('quire-theme');
                }
            } catch {
                // Keep the current visit usable when persistence is unavailable.
            }

            applyTheme();
        });
    });
})();
