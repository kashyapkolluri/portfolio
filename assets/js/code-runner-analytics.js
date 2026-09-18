/*
 * assets/js/code-runner-analytics.js
 *
 * _layouts/post.html already loads this file on every lesson page:
 *
 *     <script src="{{ site.baseurl }}/assets/js/code-runner-analytics.js"></script>
 *
 * The file was never committed, so that tag has been resolving to a 404 and doing
 * nothing. This is that file. No existing file is modified.
 *
 * WHAT IT FIXES
 *
 * CodeExecutor.run() sends every language to a backend:
 *     python      -> ${pythonURI}/run/python
 *     javascript  -> ${pythonURI}/run/javascript
 *     java        -> ${javaURI}/run/java
 *
 * On a fork served from a github.io origin those calls fail before the request is
 * even sent. config.js sets `credentials: 'include'`, and a credentialed CORS request
 * is rejected unless the server echoes this exact origin back in
 * Access-Control-Allow-Origin. The backend allowlists the Open Coding Society origins,
 * so the preflight is refused and the browser reports "Failed to fetch".
 *
 * CodeExecutor does have an in browser JavaScript fallback, but it is gated behind
 * `isLocalhost`, so on a deployed site it can never run.
 *
 * HOW THIS FILE FIXES IT
 *
 * This is a classic script, so it executes before any `type="module"` script on the
 * page, which means it is in place before any runner is built. It wraps window.fetch
 * and watches only for the three run endpoints above. Everything else on the site is
 * passed straight through untouched.
 *
 * For an intercepted call it keeps the server first design:
 *   1. Try the real backend once.
 *   2. If the backend answers, hand that answer back and change nothing.
 *   3. If it fails, run the code locally and return a normal JSON Response shaped
 *      exactly like the backend's, so CodeExecutor cannot tell the difference.
 *
 * Once the backend has failed, that result is remembered for the rest of the page load
 * and later runs go straight to local execution with no waiting.
 *
 *   JavaScript -> executed by the browser itself
 *   Python     -> executed by Pyodide, the same CDN and version already used by
 *                 _includes/hack.html, loaded only if a Python cell is actually run
 *   Java       -> passed through, since a browser has no Java engine
 */

(function () {
    'use strict';

    if (window.__codeRunnerLocalReady) return;
    window.__codeRunnerLocalReady = true;

    var RUN_ENDPOINT = /\/run\/(python|javascript|java)\/?$/;
    var PYODIDE_BASE = 'https://cdn.jsdelivr.net/pyodide/v0.23.4/full/';
    var BACKEND_TIMEOUT_MS = 4000;

    var backendIsDown = false;
    var pyodideReady = null;

    // ---------------------------------------------------------------- helpers

    function jsonResponse(output) {
        return new Response(JSON.stringify({ output: String(output) }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    function readCode(init) {
        try {
            if (init && typeof init.body === 'string') {
                var parsed = JSON.parse(init.body);
                if (parsed && typeof parsed.code === 'string') return parsed.code;
            }
        } catch (e) { /* fall through */ }
        return '';
    }

    function stringify(value) {
        if (typeof value === 'string') return value;
        if (value instanceof Error) return value.name + ': ' + value.message;
        try { return JSON.stringify(value); } catch (e) { return String(value); }
    }

    // ------------------------------------------------------- javascript engine

    function runJavaScript(code) {
        var logs = [];
        var saved = {
            log: console.log,
            info: console.info,
            warn: console.warn,
            error: console.error
        };

        function capture(original) {
            return function () {
                var parts = Array.prototype.map.call(arguments, stringify);
                logs.push(parts.join(' '));
                original.apply(console, arguments);
            };
        }

        console.log = capture(saved.log);
        console.info = capture(saved.info);
        console.warn = capture(saved.warn);
        console.error = capture(saved.error);

        try {
            // new Function gives each run its own scope. A plain eval would reuse the
            // caller's scope, so pressing Run twice on a cell that starts with `let`
            // would throw "Identifier has already been declared" on the second press.
            new Function(code)();
            return logs.length ? logs.join('\n') : '[no output]';
        } catch (err) {
            var prefix = logs.length ? logs.join('\n') + '\n\n' : '';
            return prefix + 'Error: ' + (err && err.message ? err.message : String(err));
        } finally {
            console.log = saved.log;
            console.info = saved.info;
            console.warn = saved.warn;
            console.error = saved.error;
        }
    }

    // ----------------------------------------------------------- python engine

    function loadPyodideOnce() {
        if (pyodideReady) return pyodideReady;

        pyodideReady = new Promise(function (resolve, reject) {
            function boot() {
                if (typeof window.loadPyodide !== 'function') {
                    reject(new Error('Pyodide loaded but loadPyodide is missing'));
                    return;
                }
                window.loadPyodide({ indexURL: PYODIDE_BASE }).then(resolve, reject);
            }

            if (typeof window.loadPyodide === 'function') { boot(); return; }

            var existing = document.querySelector('script[data-code-runner-pyodide]');
            if (existing) {
                existing.addEventListener('load', boot);
                existing.addEventListener('error', function () {
                    reject(new Error('Could not download Pyodide'));
                });
                return;
            }

            var tag = document.createElement('script');
            tag.src = PYODIDE_BASE + 'pyodide.js';
            tag.setAttribute('data-code-runner-pyodide', 'true');
            tag.onload = boot;
            tag.onerror = function () { reject(new Error('Could not download Pyodide')); };
            document.head.appendChild(tag);
        });

        return pyodideReady;
    }

    function runPython(code) {
        return loadPyodideOnce().then(function (pyodide) {
            var logs = [];
            pyodide.setStdout({ batched: function (line) { logs.push(line); } });
            pyodide.setStderr({ batched: function (line) { logs.push(line); } });

            return pyodide.runPythonAsync(code).then(function () {
                return logs.length ? logs.join('\n') : '[no output]';
            }, function (err) {
                var prefix = logs.length ? logs.join('\n') + '\n\n' : '';
                var text = String((err && err.message) || err);
                // Pyodide tracebacks repeat its own internal frames. Keep the tail, which
                // is the part that names the student's mistake.
                var lines = text.split('\n').filter(function (l) { return l.trim(); });
                return prefix + lines.slice(-4).join('\n');
            });
        }, function (loadErr) {
            return 'Could not start Python in this browser.\n' + loadErr.message;
        });
    }

    // ------------------------------------------------------------- the wrapper

    var nativeFetch = window.fetch.bind(window);

    function tryBackend(input, init) {
        if (backendIsDown) return Promise.reject(new Error('backend already known to be down'));

        var controller = typeof AbortController === 'function' ? new AbortController() : null;
        var timer = controller
            ? setTimeout(function () { controller.abort(); }, BACKEND_TIMEOUT_MS)
            : null;

        var attempt = Object.assign({}, init);
        if (controller) attempt.signal = controller.signal;

        return nativeFetch(input, attempt).then(function (res) {
            if (timer) clearTimeout(timer);
            if (!res.ok) throw new Error('server replied ' + res.status);
            return res;
        }, function (err) {
            if (timer) clearTimeout(timer);
            backendIsDown = true;
            throw err;
        });
    }

    window.fetch = function (input, init) {
        var url = '';
        try {
            url = typeof input === 'string' ? input : (input && input.url) || '';
        } catch (e) { url = ''; }

        var match = RUN_ENDPOINT.exec(url);

        // Not a code runner call. Leave the rest of the site completely alone.
        if (!match || !init || String(init.method).toUpperCase() !== 'POST') {
            return nativeFetch(input, init);
        }

        var language = match[1];

        // A browser cannot run Java. Let this behave exactly as it always has.
        if (language === 'java') {
            return nativeFetch(input, init);
        }

        var code = readCode(init);

        return tryBackend(input, init).catch(function () {
            // Backend unreachable. Run it here instead and answer in the same shape the
            // backend would have used, so CodeExecutor needs no changes.
            if (language === 'javascript') {
                return jsonResponse(runJavaScript(code));
            }
            return runPython(code).then(jsonResponse);
        });
    };
})();