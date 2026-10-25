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

        const toggle = document.querySelector('.theme-switch');

        if (toggle) {
            toggle.checked = dark;
        }
    }

    applyTheme();
    preference.addEventListener('change', applyTheme);
    document.addEventListener('DOMContentLoaded', () => {
        const toggle = document.querySelector('.theme-switch');

        document.querySelector('.theme-control').hidden = false;
        applyTheme();
        toggle.addEventListener('change', () => {
            savedTheme = toggle.checked ? 'dark' : 'light';

            try {
                globalThis.localStorage.setItem('quire-theme', savedTheme);
            } catch {
                // Keep the current visit usable when persistence is unavailable.
            }

            applyTheme();
        });
    });
})();
