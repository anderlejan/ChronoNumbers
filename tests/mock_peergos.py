#!/usr/bin/env python3
"""A small stand-in for the Peergos app sandbox, for fast browser tests of ChronoNumbers.

  python3 tests/mock_peergos.py [port]          (port default: MOCK_PORT from the environment / .env, 8811)
  open http://localhost:<port>/index.html?username=test&pgi=t&theme=dark-mode

It serves assets/ (or MOCK_ROOT) and the part of /peergos-api the app uses:
  /peergos-api/v0/data/<path>   GET (200 / 404) · PUT (201 new / 200 replaced) · DELETE (204), in memory
Test hooks:
  GET  /mock/state                         {"files": {path: text}, "puts": n, "gets": n}
  POST /mock/reset                         {"files": {path: text}} (optional initial files)
  POST /mock/fail   {"method": "GET", "status": 500, "count": 1}   answer the next requests with an error
  POST /mock/hang   {"method": "GET", "count": 1}                   never answer the next requests
  POST /mock/delay  {"seconds": 1.5}                                answer every data request slowly
"""
import json, os, sys, threading, time
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, unquote

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'tools'))
import env  # noqa: E402

ROOT = os.environ.get('MOCK_ROOT') or os.path.join(env.ROOT, 'assets')
LOCK = threading.Lock()
FILES = {}
STATS = {'puts': 0, 'gets': 0}
FAULTS = []      # [{"method", "status"|None (hang), "count"}]
DELAY = {'seconds': 0.0}
MIME = {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json'}
API = '/peergos-api/v0/data/'


class H(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *a):
        pass

    def send(self, code, body=b'', ctype='application/json', headers=None):
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        # the same isolation headers the Peergos sandbox sets
        self.send_header('Cross-Origin-Embedder-Policy', 'credentialless')
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; "
                         "style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob:; connect-src 'self' data:;")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if body and self.command != 'HEAD':
            self.wfile.write(body)

    def body(self):
        n = int(self.headers.get('Content-Length') or 0)
        return self.rfile.read(n) if n else b''

    def fault(self):
        with LOCK:
            for f in FAULTS:
                if f['method'] == self.command and f['count'] > 0:
                    f['count'] -= 1
                    return f
        return None

    def data(self):
        path = unquote(urlparse(self.path).path[len(API):])
        payload = self.body()  # always read it: an unread body would be taken for the next request
        f = self.fault()
        if f is not None:
            if f.get('status') is None:
                time.sleep(3600)  # never answer (the app must time out on its own)
                return
            return self.send(f['status'], json.dumps({'error': 'mock failure'}).encode())
        if DELAY['seconds']:
            time.sleep(DELAY['seconds'])
        with LOCK:
            if self.command == 'GET':
                STATS['gets'] += 1
                if path in FILES:
                    return self.send(200, FILES[path])
                if any(p.startswith(path.rstrip('/') + '/') for p in FILES) or path == '':
                    names = sorted({p[len(path):].split('/')[0] for p in FILES if p.startswith(path)})
                    return self.send(200, json.dumps({'files': names, 'subFolders': []}).encode())
                return self.send(404, b'{"error":"not found"}')
            if self.command == 'PUT':
                STATS['puts'] += 1
                existed = path in FILES
                FILES[path] = payload
                return self.send(200 if existed else 201, b'', headers={} if existed else {'Location': API + path})
            if self.command == 'DELETE':
                FILES.pop(path, None)
                return self.send(204)
        self.send(405)

    def control(self):
        p = urlparse(self.path).path
        if self.command == 'GET' and p == '/mock/state':
            with LOCK:
                return self.send(200, json.dumps({'files': {k: v.decode('utf-8', 'replace') for k, v in FILES.items()}, **STATS}).encode())
        req = json.loads(self.body() or b'{}')
        with LOCK:
            if p == '/mock/reset':
                FILES.clear(); FAULTS.clear(); DELAY['seconds'] = 0.0; STATS.update(puts=0, gets=0)
                for k, v in (req.get('files') or {}).items():
                    FILES[k] = v.encode('utf-8') if isinstance(v, str) else json.dumps(v).encode()
            elif p == '/mock/fail':
                FAULTS.append({'method': req.get('method', 'GET'), 'status': int(req.get('status', 500)), 'count': int(req.get('count', 1))})
            elif p == '/mock/hang':
                FAULTS.append({'method': req.get('method', 'GET'), 'status': None, 'count': int(req.get('count', 1))})
            elif p == '/mock/delay':
                DELAY['seconds'] = float(req.get('seconds', 0))
            else:
                return self.send(404)
        self.send(200, b'{}')

    def static(self):
        p = urlparse(self.path).path
        if p in ('', '/'):
            p = '/index.html'
        full = os.path.normpath(os.path.join(ROOT, p.lstrip('/')))
        if not full.startswith(os.path.normpath(ROOT)) or not os.path.isfile(full):
            return self.send(404, b'not found', 'text/plain')
        with open(full, 'rb') as f:
            self.send(200, f.read(), MIME.get(os.path.splitext(full)[1], 'application/octet-stream'))

    def route(self):
        p = urlparse(self.path).path
        if p.startswith(API):
            return self.data()
        if p.startswith('/mock/'):
            return self.control()
        if self.command in ('GET', 'HEAD'):
            return self.static()
        self.send(405)

    do_GET = do_PUT = do_DELETE = do_POST = do_HEAD = route


def serve(port):
    srv = ThreadingHTTPServer(('127.0.0.1', port), H)
    srv.daemon_threads = True
    return srv


if __name__ == '__main__':
    env.load()
    port = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ['MOCK_PORT'])
    print('mock Peergos on http://localhost:%d/index.html?username=test&pgi=t (serving %s)' % (port, ROOT), flush=True)
    serve(port).serve_forever()
