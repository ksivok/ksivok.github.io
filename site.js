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
    let captchaReady = false;
    let submitting = false;
    let captchaFailed = false;
    let controller = null;
    let loadTimeout = null;

    const game = selectedGame(window.location.search,
        Array.from(gameSelect.options, option => option.value));
    if (game) gameSelect.value = game;

    function showStatus(message, state, focus = false) {
        status.textContent = message;
        status.dataset.state = state;
        if (focus && typeof status.focus === 'function') status.focus();
    }

    function withAbort(promise, signal) {
        return new Promise(function (resolve, reject) {
            const abort = () => reject(new Error('Request interrupted'));
            if (signal.aborted) abort();
            else signal.addEventListener('abort', abort, { once: true });
            Promise.resolve(promise).then(function (value) {
                signal.removeEventListener('abort', abort);
                resolve(value);
            }, function (error) {
                signal.removeEventListener('abort', abort);
                reject(error);
            });
        });
    }

    form.addEventListener('submit', async function (event) {
        // Always stay on this page. Only the provider's final JSON acceptance is success.
        event.preventDefault();
        if (!configured || form.action !== endpoint || submitting || button.disabled || !captchaReady) return;
        if (typeof form.reportValidity === 'function' && !form.reportValidity()) return;

        // Collect before disabling the fieldset: disabled fields are omitted from FormData.
        const data = new FormData(form);
        submitting = true;
        fields.disabled = true;
        button.disabled = true;
        button.textContent = 'Checking…';
        form.setAttribute('aria-busy', 'true');
        showStatus('Running the spam check. Your message has not been sent yet.', 'pending');
        controller = new AbortController();
        const request = controller;
        const timeout = window.setTimeout(() => request.abort(), 25000);
        let posted = false;
        try {
            // v3 tokens expire and are single-use: obtain one only for this submission.
            const token = await withAbort(window.grecaptcha.execute(sitekey, { action: 'submit' }), request.signal);
            if (request.signal.aborted || typeof token !== 'string' || !token.trim()) throw new Error('Spam check failed');
            data.set('g-recaptcha-response', token);
            button.textContent = 'Sending…';
            showStatus('Sending your message. Please wait for confirmation.', 'pending');
            posted = true;
            const response = await withAbort(window.fetch(endpoint, {
                method: 'POST',
                mode: 'cors',
                body: data,
                headers: { Accept: 'application/json' },
                credentials: 'omit',
                redirect: 'error',
                signal: request.signal
            }), request.signal);
            const payload = await withAbort(response.json(), request.signal);
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
                    ? 'Please check your message: ' + detail + ' Your text has been kept. A new spam check will run when you retry.'
                    : 'The service could not accept your message. Your text has been kept. Please try later or email ksivok@gmail.com.', 'error', true);
            } else {
                showStatus('We could not confirm that your message was accepted. Your text has been kept. Please wait before retrying, or email ksivok@gmail.com.', 'error', true);
            }
        } catch (_) {
            showStatus(posted
                ? 'We could not confirm that your message was sent. Your text has been kept. Please wait before retrying, check your connection, or email ksivok@gmail.com.'
                : 'The spam check could not complete, so your message was not sent. Your text has been kept. Please try again or email ksivok@gmail.com.', 'error', true);
        } finally {
            window.clearTimeout(timeout);
            controller = null;
            submitting = false;
            fields.disabled = false;
            button.disabled = !captchaReady || captchaFailed;
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
        captchaReady = false;
        window.clearTimeout(loadTimeout);
        if (!submitting) {
            button.disabled = true;
            showStatus('The CAPTCHA could not load. Your text is still here. Please reload the page or email ksivok@gmail.com directly.', 'error');
        }
    }

    window.onContactCaptchaReady = function () {
        if (captchaReady || captchaFailed) return;
        try {
            window.grecaptcha.ready(function () {
                if (captchaFailed) return;
                if (typeof window.grecaptcha.execute !== 'function') { captchaError(); return; }
                window.clearTimeout(loadTimeout);
                captchaReady = true;
                button.disabled = submitting;
                if (!submitting) showStatus('Spam protection is ready. Send your message to receive confirmation here.', 'info');
            });
        } catch (_) { captchaError(); }
    };

    // Define the callback before loading Google's API to avoid script-loading races.
    const script = document.createElement('script');
    // Formspree verifies v3 with the matching legacy secret configured in its dashboard.
    script.src = 'https://www.google.com/recaptcha/api.js?onload=onContactCaptchaReady&render=' + encodeURIComponent(sitekey);
    script.async = true;
    script.defer = true;
    script.addEventListener('error', captchaError);
    loadTimeout = window.setTimeout(captchaError, 15000);
    document.head.appendChild(script);

    window.addEventListener('pageshow', function () {
        // History restoration is not evidence of delivery; never clear or invent success here.
        if (!submitting) {
            fields.disabled = false;
            button.disabled = !captchaReady || captchaFailed;
            button.textContent = 'Send message';
            form.removeAttribute('aria-busy');
        }
    });
    window.addEventListener('pagehide', function () {
        if (controller) controller.abort();
    });
}());
