package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const port = 9527

var corsHeaders = map[string]string{
	"Access-Control-Allow-Origin":          "*",
	"Access-Control-Allow-Methods":         "GET, POST, PUT, DELETE, OPTIONS",
	"Access-Control-Allow-Headers":         "*",
	"Access-Control-Expose-Headers":        "*",
	"Access-Control-Allow-Private-Network": "true",
	"Access-Control-Max-Age":               "86400",
}

var hopByHopHeaders = map[string]struct{}{
	"connection":          {},
	"keep-alive":          {},
	"proxy-authenticate":  {},
	"proxy-authorization": {},
	"te":                  {},
	"trailer":             {},
	"transfer-encoding":   {},
	"upgrade":             {},
	"host":                {},
	"origin":              {},
	"referer":             {},
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("/", handleRequest)

	addr := fmt.Sprintf("127.0.0.1:%d", port)
	log.Printf("[proxy-server] 本地代理服务已启动: http://%s", addr)
	log.Printf("[proxy-server] 支持路由: /ping, /proxy?url=<target>")
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatalf("[proxy-server] 启动失败: %v", err)
	}
}

func handleRequest(w http.ResponseWriter, r *http.Request) {
	applyCORS(w.Header())

	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	switch r.URL.Path {
	case "/ping":
		writeJSON(w, http.StatusOK, map[string]string{
			"status": "ok",
			"time":   time.Now().UTC().Format(time.RFC3339Nano),
		})
	case "/list-files":
		writeJSON(w, http.StatusOK, map[string]any{"files": []string{}})
	case "/proxy":
		handleProxy(w, r)
	default:
		writeJSON(w, http.StatusNotFound, map[string]string{
			"error": "not found",
			"path":  r.URL.Path,
		})
	}
}

func handleProxy(w http.ResponseWriter, r *http.Request) {
	target := strings.TrimSpace(r.URL.Query().Get("url"))
	if target == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Missing ?url= parameter"})
		return
	}

	parsed, err := url.Parse(target)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid target URL"})
		return
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Unsupported target URL protocol"})
		return
	}

	outReq, err := http.NewRequest(r.Method, parsed.String(), r.Body)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Failed to create upstream request", "detail": err.Error()})
		return
	}
	copyRequestHeaders(outReq.Header, r.Header)
	outReq.Host = parsed.Host

	resp, err := http.DefaultClient.Do(outReq)
	if err != nil {
		log.Printf("[proxy] upstream error: %s", err.Error())
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "Upstream request failed", "detail": err.Error()})
		return
	}
	defer resp.Body.Close()

	for key, values := range resp.Header {
		if shouldSkipHeader(key) {
			continue
		}
		for _, value := range values {
			w.Header().Add(key, value)
		}
	}
	applyCORS(w.Header())
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}

func copyRequestHeaders(dst, src http.Header) {
	for key, values := range src {
		if shouldSkipHeader(key) {
			continue
		}
		for _, value := range values {
			dst.Add(key, value)
		}
	}
}

func shouldSkipHeader(key string) bool {
	_, ok := hopByHopHeaders[strings.ToLower(key)]
	return ok
}

func applyCORS(header http.Header) {
	for key, value := range corsHeaders {
		header.Set(key, value)
	}
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	applyCORS(w.Header())
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}
