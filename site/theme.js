(() => {
    const preference = globalThis.matchMedia('(prefers-color-scheme: dark)');
    let savedTheme;

    try {
        savedTheme = globalThis.localStorage.getItem('quire-theme');
    } catch {
        // Storage can be disabled; the toggle still works for this visit.
    }

    if (savedTheme !== 'light' && savedTheme !== 'dark') {
        savedTheme = undefined;
    }

    /** Apply the saved choice, or follow the current system preference. */
    function applyTheme() {
        const dark = savedTheme ? savedTheme === 'dark' : preference.matches;

        document.documentElement.dataset.theme = dark ? 'dark' : 'light';
        document.querySelector('meta[name="theme-color"]').content = dark ? '#111113' : '#f5f3ed';

        const button = document.querySelector('.theme-toggle');

        if (button) {
            button.setAttribute('aria-pressed', String(dark));
        }
    }

    applyTheme();
    preference.addEventListener('change', applyTheme);
    document.addEventListener('DOMContentLoaded', () => {
        const button = document.querySelector('.theme-toggle');

        button.hidden = false;
        applyTheme();
        button.addEventListener('click', () => {
            savedTheme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';

            try {
                globalThis.localStorage.setItem('quire-theme', savedTheme);
            } catch {
                // Keep the current visit usable when persistence is unavailable.
            }

            applyTheme();
        });
    });
})();
