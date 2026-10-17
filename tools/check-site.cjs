#!/usr/bin/env node
'use strict';

// Offline technical checks only: no browser automation or network requests.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'site.js'), 'utf8');
const { formEndpoint, selectedGame, submissionAccepted } = require(path.join(root, 'site.js'));
let passed = 0;
let failed = 0;
let checkedLinks = 0;
const cases = [];

function check(name, run) {
    cases.push({ name, run });
}

check('AJAX submission requires an explicit acceptance validator', () => {
    assert.equal(typeof submissionAccepted, 'function', 'missing submissionAccepted helper');
    assert.match(source, /\bfetch\s*\(/, 'submission must use the AJAX response');
});

function decode(value) {
    return value.replace(/&(?:amp|quot|apos|lt|gt|#\d+|#x[\da-f]+);/gi, entity => {
        const named = { '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>' };
        if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
        const hex = entity[2].toLowerCase() === 'x';
        return String.fromCodePoint(parseInt(entity.slice(hex ? 3 : 2, -1), hex ? 16 : 10));
    });
}

// Scoped to the hand-authored pages, not a general HTML validator.
const documents = new Map();
function readDocument(file) {
    if (documents.has(file)) return documents.get(file);
    const html = fs.readFileSync(path.join(root, file), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    const tags = Array.from(html.matchAll(/<([a-z][\w:-]*)\b([^<>]*)>/gi), match => {
        const attrs = Object.create(null);
        for (const attr of match[2].matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
            attrs[attr[1].toLowerCase()] = decode(attr[2] ?? attr[3] ?? attr[4] ?? '');
        }
        return { tag: match[1].toLowerCase(), attrs };
    });
    const ids = tags.filter(node => 'id' in node.attrs).map(node => node.attrs.id);
    const doc = { html, tags, ids, byId: id => tags.find(node => node.attrs.id === id) };
    documents.set(file, doc);
    return doc;
}

function localReference(value, from) {
    const url = new URL(value, 'https://ksivok-games.org/' + from.replaceAll(path.sep, '/'));
    if (url.origin !== 'https://ksivok-games.org') return;
    const resolved = path.resolve(root, '.' + decodeURIComponent(url.pathname));
    assert.ok(resolved === root || resolved.startsWith(root + path.sep), 'reference escapes site: ' + value);
    const target = fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()
        ? path.join(resolved, 'index.html') : resolved;
    assert.ok(fs.existsSync(target), from + ' has missing local target: ' + value);
    checkedLinks++;
    if (url.hash && /\.html?$/i.test(target)) {
        const doc = readDocument(path.relative(root, target));
        const anchor = decodeURIComponent(url.hash.slice(1));
        assert.ok(doc.ids.includes(anchor) || doc.tags.some(node => node.tag === 'a' && node.attrs.name === anchor),
            from + ' has missing anchor: ' + value);
    }
}

check('local page links, assets, anchors, and unique IDs', () => {
    for (const page of ['index.html', 'gardenkin.html', 'contact.html', 'privacy.html']) {
        const doc = readDocument(page);
        assert.ok(!/<\/[a-z][\w:-]*\s+[^\s>]/i.test(doc.html), page + ' has a closing tag with unexpected attributes');
        assert.equal(new Set(doc.ids).size, doc.ids.length, page + ' has duplicate IDs');
        for (const node of doc.tags) {
            for (const attr of ['href', 'src', 'poster']) {
                if (attr in node.attrs) localReference(node.attrs[attr], page);
            }
            if (node.tag === 'meta' && node.attrs.property === 'og:image') localReference(node.attrs.content, page);
            for (const attr of ['aria-labelledby', 'aria-describedby']) {
                for (const id of (node.attrs[attr] || '').split(/\s+/).filter(Boolean)) {
                    assert.ok(doc.ids.includes(id), page + ' has missing ' + attr + ' target: ' + id);
                }
            }
        }
    }
    const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const match of css.matchAll(/url\(\s*['"]?([^'"\s)]+)['"]?\s*\)/g)) localReference(match[1], 'style.css');
});

const contact = readDocument('contact.html');
const form = contact.byId('contact-form');
const options = Array.from(contact.html.match(/<select\b[^>]*id="game"[^>]*>([\s\S]*?)<\/select>/i)[1]
    .matchAll(/<option\b[^>]*value="([^"]*)"/gi), match => decode(match[1]));

check('contact labels, required field names, and disabled fallback', () => {
    assert.equal(contact.tags.filter(node => node.tag === 'form').length, 1);
    const controls = contact.tags.filter(node => ['input', 'select', 'textarea'].includes(node.tag));
    const names = controls.map(node => node.attrs.name);
    assert.equal(new Set(names).size, names.length, 'duplicate control names');
    assert.deepEqual(names.slice().sort(), ['_gotcha', 'email', 'game', 'message', 'name', 'subject', 'topic'].sort());
    for (const control of controls.filter(node => node.attrs.type !== 'hidden')) {
        assert.ok(control.attrs.id, 'control without an ID');
        assert.ok(contact.tags.some(node => node.tag === 'label' && node.attrs.for === control.attrs.id), 'missing label for ' + control.attrs.id);
    }
    for (const name of ['email', 'message']) {
        const control = controls.find(node => node.attrs.name === name);
        assert.ok(control && 'required' in control.attrs, name + ' must be required');
    }
    assert.equal(contact.byId('email').attrs.type, 'email');
    assert.ok(options.includes('gardenkin'), 'Gardenkin must be an actual selectable option');
    assert.equal(contact.byId('contact-submit').attrs.type, 'submit');
    assert.ok('disabled' in contact.byId('contact-fields').attrs);
    assert.ok('disabled' in contact.byId('contact-submit').attrs);
    assert.ok(contact.tags.some(node => node.tag === 'a' && node.attrs.href === 'mailto:ksivok@gmail.com'));
});

check('HTTPS fallback, explicit CAPTCHA configuration, and restricted CSP', () => {
    assert.equal(form.attrs.method.toLowerCase(), 'post');
    const id = form.attrs['data-formspree-id'];
    assert.equal(typeof id, 'string');
    assert.ok(id === '' || formEndpoint(id), 'configuration must contain only a public form ID');
    const action = new URL(form.attrs.action);
    assert.equal(action.origin, 'https://formspree.io');
    assert.equal(action.pathname, '/f/' + id);
    assert.equal(action.search + action.hash + action.username + action.password, '');
    const meta = contact.tags.find(node => node.tag === 'meta' && node.attrs['http-equiv']?.toLowerCase() === 'content-security-policy');
    assert.ok(meta, 'missing contact CSP');
    const policy = new Map(meta.attrs.content.split(';').map(part => part.trim().split(/\s+/)).filter(part => part[0]).map(([name, ...values]) => [name, values]));
    assert.deepEqual(policy.get('form-action'), ['https://formspree.io']);
    assert.deepEqual(policy.get('default-src'), ["'self'"]);
    assert.deepEqual(policy.get('script-src')?.slice().sort(), ["'self'", 'https://www.google.com/recaptcha/', 'https://www.gstatic.com/recaptcha/'].sort());
    assert.deepEqual(policy.get('connect-src')?.slice().sort(), ["'self'", 'https://formspree.io', 'https://www.google.com/recaptcha/'].sort());
    assert.deepEqual(policy.get('frame-src')?.slice().sort(), ['https://www.google.com/recaptcha/', 'https://recaptcha.google.com/recaptcha/'].sort());
    for (const name of ['base-uri', 'object-src']) assert.deepEqual(policy.get(name), ["'none'"]);
    assert.ok(!/unsafe-inline|unsafe-eval/.test(meta.attrs.content));
    assert.ok(!contact.tags.some(node => 'formaction' in node.attrs || 'onsubmit' in node.attrs));
    const scripts = contact.tags.filter(node => node.tag === 'script');
    assert.equal(scripts.length, 1);
    assert.equal(new URL(scripts[0].attrs.src, 'https://ksivok-games.org/').pathname, '/site.js');
    assert.equal(contact.byId('contact-captcha')?.attrs['data-sitekey'], '6LfyqfMtAAAAACIZ49mRh02kqPGEuXETaKo37tCw');
    assert.ok(!/\.innerHTML\s*=/.test(source), 'status must use textContent, not HTML');
    assert.ok(!/\b(?:XMLHttpRequest|sendBeacon)\s*\(/.test(source), 'unexpected request API');
});

check('endpoint validation rejects URL injection and malformed IDs', () => {
    for (const id of [undefined, null, 123456, {}, [], '', 'short', 'A123456', 'test-form', 'test_form', 'a'.repeat(41),
        ' testform', 'testform ', 'testform\n', 'testform\r', 'https://evil.example/steal', '//evil.example',
        'testform?redirect=https://evil.example', 'testform/../other', 'testform#other']) {
        assert.equal(formEndpoint(id), null, 'accepted invalid form ID: ' + JSON.stringify(id));
    }
    for (const id of ['a'.repeat(6), 'testform', '123456', 'a'.repeat(40)]) {
        assert.equal(formEndpoint(id), 'https://formspree.io/f/' + id);
    }
});

check('game prefill uses only actual select options', () => {
    for (const game of options) assert.equal(selectedGame('?game=' + encodeURIComponent(game), options), game);
    for (const search of ['', '?game=unknown', '?game=GARDENKIN', '?game=https://evil.example', '?game=%3Cscript%3E',
        '?formspreeId=testform', '?game=general%26action%3Dhttps%3A%2F%2Fevil.example']) {
        assert.equal(selectedGame(search, options), null, 'accepted invalid prefill: ' + search);
    }
    assert.equal(selectedGame('?game=gardenkin&action=https://evil.example', options), 'gardenkin');
    assert.equal(selectedGame('?game=unknown&game=gardenkin', options), null);
});

function response(payload = { next: 'https://formspree.io/thanks' }, overrides = {}) {
    return Object.assign({
        ok: true, status: 200, redirected: false, type: 'cors',
        headers: { get: name => name.toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null },
        json: async () => payload
    }, overrides);
}

check('acceptance validator requires successful JSON with Formspree thanks destination', () => {
    assert.equal(typeof submissionAccepted, 'function', 'missing submissionAccepted helper');
    for (const next of ['https://formspree.io/thanks', 'https://formspree.io/thanks/', 'https://formspree.io/thanks?language=en', 'https://formspree.io/thanks/?language=en', '/thanks', '/thanks/?language=en']) {
        assert.equal(submissionAccepted(response(), { next }), true, 'rejected confirmed thanks response: ' + next);
    }
    for (const payload of [null, undefined, '', [], {}, { ok: true }, { next: 123 },
        { next: 'https://formspree.io/thanks', errors: [{ message: 'Rejected' }] },
        { next: 'https://formspree.io/thanks', error: 'Rejected' },
        { next: 'https://formspree.io/thanks', ok: false }, { next: 'https://formspree.io/thanks', success: false },
        ...['https://formspree.io/captcha', 'https://formspree.io/unknown', 'https://formspree.io/thanks/extra',
            'http://formspree.io/thanks', 'https://evil.example/thanks', 'https://formspree.io.evil.example/thanks',
            'javascript:alert(1)', '//evil.example/thanks'].map(next => ({ next }))]) {
        assert.equal(submissionAccepted(response(), payload), false, 'accepted unconfirmed payload: ' + JSON.stringify(payload));
    }
    const payload = { next: 'https://formspree.io/thanks' };
    for (const res of [null, response(payload, { ok: false, status: 422 }), response(payload, { redirected: true }),
        response(payload, { headers: { get: () => 'text/html' } }), response(payload, { type: 'opaqueredirect', ok: false, status: 0 })]) {
        assert.equal(submissionAccepted(res, payload), false, 'accepted failed/redirected/non-JSON response');
    }
});

function fixture(config = {}) {
    const formId = config.formId ?? 'testform';
    const sitekey = config.sitekey ?? contact.byId('contact-captcha')?.attrs['data-sitekey'];
    const fetchCalls = [], scripts = [], renders = [], resetCalls = [], controllers = [], states = [];
    const pendingResponses = (config.responses || []).slice();
    const timers = new Map();
    let timerId = 0, token = '', resetCount = 0, nativeSubmissions = 0;
    function element(properties = {}) {
        const node = Object.assign({
            attributes: {}, listeners: new Map(), dataset: {}, textContent: '',
            classList: { add() {}, remove() {}, toggle() {} },
            addEventListener(name, listener) { this.listeners.set(name, listener); },
            setAttribute(name, value) { this.attributes[name] = String(value); },
            removeAttribute(name) { delete this.attributes[name]; },
            focus() {},
            getBoundingClientRect() { return { width: config.width ?? 800 }; }
        }, properties);
        Object.defineProperty(node, 'innerHTML', { set() { throw new Error('unsafe innerHTML assignment'); } });
        return node;
    }
    const elements = {
        year: element({ textContent: '' }),
        'contact-form': element({ dataset: { formspreeId: formId }, action: form.attrs.action,
            checkValidity: () => config.valid !== false, reportValidity: () => config.valid !== false,
            submit() { nativeSubmissions++; }, requestSubmit() { nativeSubmissions++; } }),
        'contact-fields': element({ disabled: true }),
        'contact-submit': element({ disabled: true, textContent: 'Send message' }),
        'form-status': element({ textContent: 'Email fallback', dataset: new Proxy({}, { set(target, key, value) { states.push(value); target[key] = value; return true; } }) }),
        'contact-captcha': element({ dataset: { sitekey } }),
        game: element({ name: 'game', value: 'general', options: options.map(value => ({ value })) }),
        name: element({ name: 'name', value: 'Sample name' }),
        email: element({ name: 'email', value: 'sample@example.invalid' }),
        message: element({ name: 'message', value: 'Keep this message until confirmed.' }),
        topic: element({ name: 'topic', value: 'feedback' }),
        website: element({ name: '_gotcha', value: '' })
    };
    elements['contact-form'].reset = () => {
        resetCount++;
        for (const id of ['name', 'email', 'message', 'website']) elements[id].value = '';
        elements.game.value = 'general'; elements.topic.value = 'feedback';
    };
    class FakeFormData extends Map {
        constructor() {
            super();
            this.set('subject', 'Ksivok Games — website feedback');
            this.set('_gotcha', elements.website.value);
            if (!elements['contact-fields'].disabled) {
                for (const id of ['name', 'email', 'message', 'game', 'topic']) this.set(id, elements[id].value);
            }
        }
        append(name, value) { this.set(name, value); }
    }
    class FakeAbortController {
        constructor() {
            const listeners = new Set();
            this.signal = { aborted: false, addEventListener: (name, callback) => { if (name === 'abort') listeners.add(callback); }, removeEventListener: (name, callback) => listeners.delete(callback) };
            this.abort = () => { this.signal.aborted = true; for (const callback of listeners) callback(); };
            controllers.push(this);
        }
    }
    const captcha = {
        render(target, settings) { renders.push({ target, settings }); return 0; },
        getResponse(widget) { assert.equal(widget, 0); return token; },
        reset(widget) { assert.equal(widget, 0); resetCalls.push(widget); token = ''; }
    };
    const window = element({ location: { search: config.search ?? '?game=gardenkin' }, innerWidth: config.width ?? 800,
        setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
        clearTimeout(id) { timers.delete(id); },
        fetch(url, init) {
            fetchCalls.push({ url, init });
            const next = pendingResponses.length ? pendingResponses.shift() : response();
            return new Promise((resolve, reject) => {
                const abort = () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
                init.signal?.addEventListener('abort', abort);
                if (init.signal?.aborted) return abort();
                Promise.resolve().then(() => typeof next === 'function' ? next() : next).then(resolve, reject);
            });
        }
    });
    const document = {
        getElementById: id => config.withForm === false && id === 'contact-form' ? null : elements[id] || null,
        createElement(tag) { assert.equal(tag, 'script'); return element(); },
        head: { appendChild(script) { assert.equal(typeof window.onContactCaptchaReady, 'function', 'callback must exist before loading script'); scripts.push(script); } }
    };
    vm.runInNewContext(source, { document, window, URL, URLSearchParams, FormData: FakeFormData, AbortController: FakeAbortController }, { timeout: 1000 });
    return {
        elements, window, fetchCalls, scripts, renders, resetCalls, controllers, timers, states,
        get resetCount() { return resetCount; }, get nativeSubmissions() { return nativeSubmissions; },
        get token() { return token; },
        snapshot() { return ['name', 'email', 'message', 'game', 'topic'].map(id => elements[id].value); },
        ready() { window.grecaptcha = captcha; window.onContactCaptchaReady?.(); },
        solve(value = 'synthetic-captcha-token') { token = value; renders.at(-1)?.settings.callback?.(value); },
        expire() { token = ''; renders.at(-1)?.settings['expired-callback']?.(); },
        captchaError() { token = ''; renders.at(-1)?.settings['error-callback']?.(); },
        dispatch(name) { window.listeners.get(name)?.({ persisted: true }); },
        fireTimers() { for (const [id, timer] of [...timers]) { timers.delete(id); timer.callback(); } },
        startSubmit() {
            const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
            const finished = Promise.resolve(elements['contact-form'].listeners.get('submit')?.(event));
            finished.catch(() => {});
            return { event, finished };
        },
        async submit() { const submission = this.startSubmit(); await submission.finished; await flush(); return submission.event; }
    };
}

async function flush() { for (let count = 0; count < 16; count++) await Promise.resolve(); }
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function assertNoSuccess(state) { assert.ok(!state.states.includes('success'), 'unconfirmed response displayed success'); assert.equal(state.resetCount, 0, 'unconfirmed submission cleared form'); }

check('CAPTCHA loads only on contact page and renders explicitly with public key', () => {
    assert.equal(fixture({ withForm: false }).scripts.length, 0);
    for (const width of [320, 800]) {
        const state = fixture({ width });
        assert.equal(state.elements['contact-submit'].disabled, true, 'submit must wait for CAPTCHA loader');
        assert.equal(state.scripts.length, 1);
        const loader = new URL(state.scripts[0].src);
        assert.equal(loader.origin + loader.pathname, 'https://www.google.com/recaptcha/api.js');
        assert.equal(loader.searchParams.get('onload'), 'onContactCaptchaReady');
        assert.equal(loader.searchParams.get('render'), 'explicit');
        state.ready();
        assert.equal(state.renders.length, 1);
        assert.equal(state.renders[0].target, state.elements['contact-captcha']);
        const settings = state.renders[0].settings;
        assert.equal(settings.sitekey, '6LfyqfMtAAAAACIZ49mRh02kqPGEuXETaKo37tCw');
        assert.equal(settings.theme, 'dark');
        assert.equal(settings.size, width < 360 ? 'compact' : 'normal');
        for (const name of ['callback', 'expired-callback', 'error-callback']) assert.equal(typeof settings[name], 'function');
        state.ready();
        assert.equal(state.renders.length, 1, 'duplicate loader callback must not render another widget');
    }
});

check('invalid endpoint/missing key/loader failure cannot submit', async () => {
    for (const id of ['', 'https://evil.example', 'invalid-id']) {
        const state = fixture({ formId: id, search: '?game=gardenkin&formspreeId=testform' });
        state.ready();
        assert.equal(state.elements['contact-submit'].disabled, true);
        assert.equal((await state.submit()).defaultPrevented, true);
        assert.equal(state.fetchCalls.length, 0);
        assertNoSuccess(state);
    }
    const noKey = fixture({ sitekey: '' });
    noKey.ready();
    assert.equal(noKey.renders.length, 0);
    assert.equal(noKey.elements['contact-submit'].disabled, true);
    assert.equal((await noKey.submit()).defaultPrevented, true);
    assert.equal(noKey.fetchCalls.length, 0);
    const failedLoader = fixture();
    const loaderError = failedLoader.scripts[0].listeners.get('error') ?? failedLoader.scripts[0].onerror;
    assert.equal(typeof loaderError, 'function', 'loader failure needs a handler');
    loaderError();
    failedLoader.dispatch('pageshow');
    assert.equal(failedLoader.elements['contact-submit'].disabled, true);
    assert.equal((await failedLoader.submit()).defaultPrevented, true);
    assert.equal(failedLoader.fetchCalls.length, 0);
    assertNoSuccess(failedLoader);
});

check('native validation, unsolved/expired/error CAPTCHA, and action tampering block sends', async () => {
    const invalid = fixture({ valid: false }); invalid.ready(); invalid.solve();
    assert.equal((await invalid.submit()).defaultPrevented, true);
    assert.equal(invalid.fetchCalls.length, 0);
    const state = fixture(); state.ready();
    const before = state.snapshot();
    assert.equal((await state.submit()).defaultPrevented, true);
    assert.equal(state.fetchCalls.length, 0);
    for (const callback of ['expire', 'captchaError']) {
        state.solve(); state[callback]();
        await state.submit();
        assert.equal(state.fetchCalls.length, 0, callback + ' token must not be used');
    }
    state.solve();
    for (const action of ['https://evil.example/steal', 'http://formspree.io/f/testform', 'https://formspree.io/f/otherid']) {
        state.elements['contact-form'].action = action;
        assert.equal((await state.submit()).defaultPrevented, true);
        assert.equal(state.fetchCalls.length, 0);
    }
    assert.deepEqual(state.snapshot(), before);
    assertNoSuccess(state);
});

check('AJAX includes token/fields, blocks duplicates, and resets only after confirmed success', async () => {
    const waiting = deferred();
    const state = fixture({ responses: [waiting.promise], search: '?game=gardenkin&action=https://evil.example&formspreeId=otherid' });
    state.ready(); state.solve();
    assert.equal(state.elements['contact-form'].action, 'https://formspree.io/f/testform');
    const first = state.startSubmit();
    assert.equal(first.event.defaultPrevented, true, 'AJAX must always cancel native submission');
    await flush();
    assert.equal(state.fetchCalls.length, 1);
    const { url, init } = state.fetchCalls[0];
    assert.equal(url, 'https://formspree.io/f/testform');
    assert.equal(init.method.toUpperCase(), 'POST');
    assert.equal(init.redirect, 'error');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.headers.Accept ?? init.headers.accept ?? init.headers.get?.('Accept'), 'application/json');
    assert.equal(init.body.get('g-recaptcha-response'), 'synthetic-captcha-token');
    assert.equal(init.body.get('email'), 'sample@example.invalid', 'FormData must precede fieldset disabling');
    assert.equal(init.body.get('message'), 'Keep this message until confirmed.');
    assert.equal(init.body.get('game'), 'gardenkin');
    assert.equal(state.elements['contact-fields'].disabled, true);
    assert.equal(state.elements['contact-submit'].disabled, true);
    assert.equal(state.elements['contact-form'].attributes['aria-busy'], 'true');
    assertNoSuccess(state);
    assert.equal((await state.submit()).defaultPrevented, true);
    assert.equal(state.fetchCalls.length, 1);
    waiting.resolve(response());
    await first.finished; await flush();
    assert.equal(state.elements['form-status'].dataset.state, 'success');
    assert.equal(state.resetCount, 1);
    assert.equal(state.elements.message.value, '');
    assert.equal(state.elements.game.value, 'gardenkin', 'reset must preserve game prefill');
    assert.ok(state.resetCalls.length >= 1);
    assert.equal(state.token, '');
    assert.equal(state.elements['contact-fields'].disabled, false);
    assert.equal(state.elements['contact-form'].attributes['aria-busy'], undefined);
    assert.equal(state.nativeSubmissions, 0);
    assert.equal(state.timers.size, 0, 'settled requests must clear timeout');
});

check('server/network/JSON/redirect errors preserve input and allow a fresh CAPTCHA retry', async () => {
    const failures = [
        response({ errors: [{ message: '<img src=x onerror=alert(1)>' }] }, { ok: false, status: 422 }),
        response({ next: 'https://formspree.io/captcha' }), response({ next: 'https://formspree.io/unknown' }),
        response({}), response({ next: 'https://formspree.io/thanks', success: false }),
        response(undefined, { redirected: true }), response(undefined, { headers: { get: () => 'text/html' } }),
        response(undefined, { json: async () => { throw new SyntaxError('Invalid JSON'); } }),
        () => { throw new TypeError('Network unavailable'); }
    ];
    for (const failure of failures) {
        const state = fixture({ responses: [failure, response()] });
        state.ready(); state.solve();
        const before = state.snapshot();
        assert.equal((await state.submit()).defaultPrevented, true);
        assert.equal(state.fetchCalls.length, 1);
        assert.deepEqual(state.snapshot(), before);
        assertNoSuccess(state);
        assert.equal(state.elements['contact-fields'].disabled, false);
        assert.ok(state.resetCalls.length >= 1, 'failed attempt must reset CAPTCHA');
        assert.equal(state.token, '');
        await state.submit();
        assert.equal(state.fetchCalls.length, 1, 'retry must require a fresh CAPTCHA token');
        state.solve('new-captcha-token');
        await state.submit();
        assert.equal(state.fetchCalls.length, 2);
        assert.equal(state.fetchCalls[1].init.body.get('g-recaptcha-response'), 'new-captcha-token');
        assert.equal(state.elements['form-status'].dataset.state, 'success');
        assert.equal(state.nativeSubmissions, 0);
        assert.equal(state.timers.size, 0);
    }
});

check('timeouts abort pending work without success or input loss', async () => {
    const state = fixture({ responses: [new Promise(() => {})] });
    state.ready(); state.solve();
    const before = state.snapshot();
    const submission = state.startSubmit();
    await flush();
    assert.equal(state.fetchCalls.length, 1);
    assert.ok(state.timers.size > 0, 'missing timeout');
    state.fireTimers();
    await submission.finished; await flush();
    assert.ok(state.controllers.some(controller => controller.signal.aborted));
    assert.deepEqual(state.snapshot(), before);
    assertNoSuccess(state);
    assert.equal(state.elements['contact-fields'].disabled, false);
    assert.equal(state.token, '');
});

check('pagehide abort and pageshow recovery retain unsent input without inventing success', async () => {
    const state = fixture({ responses: [new Promise(() => {}), response()] });
    state.ready(); state.solve();
    const before = state.snapshot();
    const submission = state.startSubmit();
    await flush();
    state.dispatch('pagehide');
    await submission.finished; await flush();
    assert.ok(state.controllers.some(controller => controller.signal.aborted));
    state.dispatch('pageshow');
    assert.deepEqual(state.snapshot(), before);
    assertNoSuccess(state);
    assert.equal(state.elements['contact-fields'].disabled, false);
    state.solve('after-back-token');
    await state.submit();
    assert.equal(state.fetchCalls.length, 2);
    assert.equal(state.elements['form-status'].dataset.state, 'success');
});

/*
 * Deliberately no live submission or browser checks. The small DOM/CAPTCHA/fetch
 * fakes verify local state transitions; they cannot verify provider deployment,
 * CAPTCHA domain registration, network delivery, or inbox receipt.
 */

async function main() {
    for (const { name, run } of cases) {
        try { await run(); passed++; console.log('PASS ' + name); }
        catch (error) { failed++; console.error('FAIL ' + name + ': ' + error.message); }
    }
    console.log(`Site checks: ${passed} passed, ${failed} failed; ${checkedLinks} local references checked. No browser or network requests used.`);
    process.exitCode = failed ? 1 : 0;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
