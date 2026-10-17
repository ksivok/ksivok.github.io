/* Public Formspree IDs are not secrets. Credentials never belong in this file. */
(function () {
    'use strict';

    function formEndpoint(formId) {
        return typeof formId === 'string' && /^[a-z0-9]{6,40}$/.test(formId)
            ? 'https://formspree.io/f/' + formId
            : null;
    }

    function selectedGame(search, options) {
        const game = new URLSearchParams(search).get('game');
        return options.includes(game) ? game : null;
    }

    // Used by the dependency-free technical checks; not loaded from a CDN.
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { formEndpoint, selectedGame };
    }
    if (typeof document === 'undefined') return;

    const year = document.getElementById('year');
    if (year) year.textContent = String(new Date().getFullYear());

    const form = document.getElementById('contact-form');
    if (!form) return;

    const fields = document.getElementById('contact-fields');
    const button = document.getElementById('contact-submit');
    const status = document.getElementById('form-status');
    const gameSelect = document.getElementById('game');
    const endpoint = formEndpoint(form.dataset.formspreeId);

    const game = selectedGame(window.location.search,
        Array.from(gameSelect.options, option => option.value));
    if (game) gameSelect.value = game;

    form.addEventListener('submit', function (event) {
        // Refuse a changed recipient or an accidental second submission.
        if (!endpoint || form.action !== endpoint || button.disabled) {
            event.preventDefault();
            return;
        }
        button.disabled = true;
        button.textContent = 'Opening secure submission…';
        form.setAttribute('aria-busy', 'true');
        // Native POST: Formspree handles validation, CAPTCHA, and the result page.
        // No local "sent" state, data storage, tracking, or optimistic success.
    });

    if (!endpoint) return; // Safe default: no submission and a visible email fallback.

    form.action = endpoint;
    fields.disabled = false;
    button.disabled = false;
    status.textContent = 'Your message will be submitted through Formspree. You may be asked to complete a spam check.';

    window.addEventListener('pageshow', function () {
        // Restore the form after returning from the provider with the Back button.
        fields.disabled = false;
        button.disabled = false;
        button.textContent = 'Send message';
        form.removeAttribute('aria-busy');
    });
}());
