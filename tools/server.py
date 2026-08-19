import http.server
import socketserver

class NoCacheHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

class ThreadingHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True

if __name__ == '__main__':
    PORT = 8080
    print(f"Server starting at http://localhost:{PORT}", flush=True)
    server = ThreadingHTTPServer(("", PORT), NoCacheHTTPRequestHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
