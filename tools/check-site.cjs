#!/usr/bin/env node
'use strict';

// Offline technical checks only: no browser automation or network requests.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'site.js'), 'utf8');
const { formEndpoint, selectedGame } = require(path.join(root, 'site.js'));
let passed = 0;
let failed = 0;
let checkedLinks = 0;

function check(name, run) {
    try { run(); passed++; console.log('PASS ' + name); }
    catch (error) { failed++; console.error('FAIL ' + name + ': ' + error.message); }
}

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

check('native POST and restricted HTTPS form destination/CSP', () => {
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
    for (const name of ['default-src', 'script-src']) assert.deepEqual(policy.get(name), ["'self'"]);
    for (const name of ['base-uri', 'object-src']) assert.deepEqual(policy.get(name), ["'none'"]);
    assert.ok(!contact.tags.some(node => 'formaction' in node.attrs || 'onsubmit' in node.attrs));
    const scripts = contact.tags.filter(node => node.tag === 'script');
    assert.equal(scripts.length, 1);
    assert.equal(scripts[0].attrs.src, 'site.js');
    assert.ok(!/\b(?:fetch|XMLHttpRequest|sendBeacon)\s*\(/.test(source), 'unexpected request API');
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

function fixture(formId, search = '') {
    function element(properties = {}) {
        return Object.assign({
            attributes: {}, listeners: new Map(),
            addEventListener(name, listener) { this.listeners.set(name, listener); },
            setAttribute(name, value) { this.attributes[name] = value; },
            removeAttribute(name) { delete this.attributes[name]; }
        }, properties);
    }
    const elements = {
        year: element({ textContent: '' }),
        'contact-form': element({ dataset: { formspreeId: formId }, action: form.attrs.action }),
        'contact-fields': element({ disabled: true }),
        'contact-submit': element({ disabled: true, textContent: 'Send message' }),
        'form-status': element({ textContent: 'Email fallback' }),
        game: element({ value: 'general', options: options.map(value => ({ value })) })
    };
    const window = element({ location: { search } });
    vm.runInNewContext(source, { document: { getElementById: id => elements[id] || null }, window, URLSearchParams }, { timeout: 1000 });
    return { elements, window, submit() {
        const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
        elements['contact-form'].listeners.get('submit')?.(event);
        return event;
    } };
}

check('unconfigured/invalid forms stay disabled and prevent submission', () => {
    for (const id of ['', 'https://evil.example', 'invalid-id']) {
        const state = fixture(id, '?game=gardenkin&formspreeId=testform');
        assert.equal(state.elements['contact-fields'].disabled, true);
        assert.equal(state.elements['contact-submit'].disabled, true);
        assert.equal(state.elements['contact-form'].action, form.attrs.action);
        assert.equal(state.elements['form-status'].textContent, 'Email fallback');
        state.window.listeners.get('pageshow')?.();
        assert.equal(state.elements['contact-fields'].disabled, true);
        assert.equal(state.elements['contact-submit'].disabled, true);
        assert.equal(state.submit().defaultPrevented, true, 'unconfigured submit must be prevented');
    }
});

check('configured form enables exact destination and safe prefill', () => {
    const state = fixture('testform', '?game=gardenkin&action=https://evil.example&formspreeId=otherid');
    assert.equal(state.elements['contact-form'].action, 'https://formspree.io/f/testform');
    assert.equal(state.elements['contact-fields'].disabled, false);
    assert.equal(state.elements['contact-submit'].disabled, false);
    assert.equal(state.elements.game.value, 'gardenkin');
    assert.match(state.elements.year.textContent, /^\d{4}$/);
    assert.equal(fixture('testform', '?game=unknown').elements.game.value, 'general');
});

check('submit blocks duplicate sends and changed destinations; Back restores controls', () => {
    const state = fixture('testform');
    assert.equal(state.submit().defaultPrevented, false, 'valid native submission should proceed');
    assert.equal(state.elements['contact-submit'].disabled, true);
    assert.equal(state.elements['contact-form'].attributes['aria-busy'], 'true');
    assert.equal(state.submit().defaultPrevented, true, 'second submit must be prevented');
    state.window.listeners.get('pageshow')();
    assert.equal(state.elements['contact-fields'].disabled, false);
    assert.equal(state.elements['contact-submit'].disabled, false);
    assert.equal(state.elements['contact-submit'].textContent, 'Send message');
    assert.equal(state.elements['contact-form'].attributes['aria-busy'], undefined);
    for (const action of ['https://evil.example/steal', 'http://formspree.io/f/testform', 'https://formspree.io/f/otherid']) {
        state.elements['contact-form'].action = action;
        assert.equal(state.submit().defaultPrevented, true, 'changed destination must be blocked: ' + action);
    }
});

console.log(`Site checks: ${passed} passed, ${failed} failed; ${checkedLinks} local references checked. No browser or network requests used.`);
process.exitCode = failed ? 1 : 0;
