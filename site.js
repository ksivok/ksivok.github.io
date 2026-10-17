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

    function submissionAccepted(response, payload) {
        if (!response || response.ok !== true || response.redirected ||
            !/^application\/json(?:\s*;|$)/i.test(response.headers?.get?.('Content-Type') || '') ||
            !payload || typeof payload !== 'object' || Array.isArray(payload) ||
            'errors' in payload || 'error' in payload || payload.ok === false || payload.success === false ||
            typeof payload.next !== 'string' || payload.next.trim() !== payload.next) return false;
        try {
            const next = new URL(payload.next, 'https://formspree.io/');
            return next.origin === 'https://formspree.io' && /^\/thanks\/?$/.test(next.pathname) &&
                !next.username && !next.password;
        } catch (_) {
            return false;
        }
    }

    // Used by the dependency-free technical checks; not loaded from a CDN.
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { formEndpoint, selectedGame, submissionAccepted };
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
    const captcha = document.getElementById('contact-captcha');
    const endpoint = formEndpoint(form.dataset.formspreeId);
    const sitekey = captcha?.dataset.sitekey;
    const configured = endpoint && typeof sitekey === 'string' && /^[A-Za-z0-9_-]{20,100}$/.test(sitekey);
    let widgetId = null;
    let submitting = false;
    let captchaFailed = false;
    let controller = null;

    const game = selectedGame(window.location.search,
        Array.from(gameSelect.options, option => option.value));
    if (game) gameSelect.value = game;

    function showStatus(message, state, focus = false) {
        status.textContent = message;
        status.dataset.state = state;
        if (focus && typeof status.focus === 'function') status.focus();
    }

    function resetCaptcha() {
        if (widgetId !== null && window.grecaptcha) {
            try { window.grecaptcha.reset(widgetId); }
            catch (_) { captchaFailed = true; }
        }
    }

    form.addEventListener('submit', async function (event) {
        // Always stay on this page. Only the provider's final JSON acceptance is success.
        event.preventDefault();
        if (!configured || form.action !== endpoint || submitting || button.disabled) return;
        if (typeof form.reportValidity === 'function' && !form.reportValidity()) return;

        let token = '';
        try {
            if (widgetId !== null && window.grecaptcha) token = window.grecaptcha.getResponse(widgetId);
        } catch (_) { /* Treat an unavailable CAPTCHA as unverified. */ }
        if (typeof token !== 'string' || !token.trim()) {
            showStatus('Please complete the CAPTCHA before sending your message.', 'error', true);
            return;
        }

        // Collect before disabling the fieldset: disabled fields are omitted from FormData.
        const data = new FormData(form);
        data.set('g-recaptcha-response', token);
        submitting = true;
        fields.disabled = true;
        button.disabled = true;
        button.textContent = 'Sending…';
        form.setAttribute('aria-busy', 'true');
        showStatus('Sending your message. Please wait for confirmation.', 'pending');
        controller = new AbortController();
        const request = controller;
        const timeout = window.setTimeout(() => request.abort(), 25000);
        try {
            const response = await window.fetch(endpoint, {
                method: 'POST',
                mode: 'cors',
                body: data,
                headers: { Accept: 'application/json' },
                credentials: 'omit',
                redirect: 'error',
                signal: request.signal
            });
            const payload = await response.json();
            if (request.signal.aborted) throw new Error('Request interrupted');
            if (submissionAccepted(response, payload)) {
                form.reset();
                if (game) gameSelect.value = game;
                showStatus('Thank you! Your message has been sent. I will reply to the email address you provided.', 'success', true);
            } else if (!response.ok || payload?.error || Array.isArray(payload?.errors)) {
                const messages = Array.isArray(payload?.errors)
                    ? payload.errors.filter(error => typeof error?.message === 'string').slice(0, 3).map(error => error.message)
                    : typeof payload?.error === 'string' ? [payload.error] : [];
                const detail = messages.join(' ').slice(0, 500);
                showStatus(detail
                    ? 'Please check your message: ' + detail + ' Your text has been kept. Complete the CAPTCHA again before retrying.'
                    : 'The service could not accept your message. Your text has been kept. Please try later or email ksivok@gmail.com.', 'error', true);
            } else {
                showStatus('We could not confirm that your message was accepted. Your text has been kept. Please wait before retrying, or email ksivok@gmail.com.', 'error', true);
            }
        } catch (_) {
            showStatus('We could not confirm that your message was sent. Your text has been kept. Please wait before retrying, check your connection, or email ksivok@gmail.com.', 'error', true);
        } finally {
            window.clearTimeout(timeout);
            controller = null;
            // Tokens are single-use, including after server rejection or an uncertain request.
            resetCaptcha();
            submitting = false;
            fields.disabled = false;
            button.disabled = widgetId === null || captchaFailed;
            button.textContent = 'Send message';
            form.removeAttribute('aria-busy');
        }
    });

    if (!configured) return; // Missing configuration never enables submission.

    form.action = endpoint;
    fields.disabled = false;
    showStatus('Loading the spam check. You can fill in your message while it loads.', 'info');

    function captchaError() {
        captchaFailed = true;
        if (!submitting) {
            button.disabled = true;
            showStatus('The CAPTCHA could not load. Your text is still here. Please reload the page or email ksivok@gmail.com directly.', 'error');
        }
    }

    window.onContactCaptchaReady = function () {
        if (widgetId !== null) return;
        try {
            const width = captcha.getBoundingClientRect?.().width || 0;
            widgetId = window.grecaptcha.render(captcha, {
                sitekey,
                theme: 'dark',
                size: width > 0 && width < 360 ? 'compact' : 'normal',
                callback: function () {
                    captchaFailed = false;
                    if (!submitting) {
                        button.disabled = false;
                        showStatus('Verification complete. Your message is ready to send.', 'info');
                    }
                },
                'expired-callback': function () {
                    if (!submitting) showStatus('The CAPTCHA has expired. Please complete it again before sending.', 'error');
                },
                'error-callback': captchaError
            });
            captchaFailed = false;
            button.disabled = false;
            showStatus('Complete the CAPTCHA, then send your message. You will see confirmation here.', 'info');
        } catch (_) { captchaError(); }
    };

    // Define the callback before loading Google's API to avoid script-loading races.
    const script = document.createElement('script');
    script.src = 'https://www.google.com/recaptcha/api.js?onload=onContactCaptchaReady&render=explicit';
    script.async = true;
    script.defer = true;
    script.addEventListener('error', captchaError);
    document.head.appendChild(script);

    window.addEventListener('pageshow', function () {
        // History restoration is not evidence of delivery; never clear or invent success here.
        if (!submitting) {
            fields.disabled = false;
            button.disabled = widgetId === null || captchaFailed;
            button.textContent = 'Send message';
            form.removeAttribute('aria-busy');
        }
    });
    window.addEventListener('pagehide', function () {
        if (controller) controller.abort();
    });
}());
