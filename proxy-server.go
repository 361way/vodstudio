package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

const port = 9527

var cacheRoot = getCacheRoot()
var configState = map[string]any{
	"save_path":          cacheRoot,
	"image_save_path":    filepath.Join(cacheRoot, "history"),
	"video_save_path":    filepath.Join(cacheRoot, "history"),
	"convert_png_to_jpg": false,
	"jpg_quality":        95,
	"pil_available":      false,
}

var safeSegmentPattern = regexp.MustCompile(`[^a-zA-Z0-9._-]+`)

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

	switch {
	case r.URL.Path == "/ping":
		payload := map[string]any{"status": "ok", "time": time.Now().UTC().Format(time.RFC3339Nano)}
		for key, value := range configState {
			payload[key] = value
		}
		writeJSON(w, http.StatusOK, payload)
	case r.URL.Path == "/config":
		handleConfig(w, r)
	case r.URL.Path == "/list-files":
		writeJSON(w, http.StatusOK, map[string]any{"files": listCacheFiles()})
	case r.URL.Path == "/save-cache":
		handleSaveCache(w, r)
	case strings.HasPrefix(r.URL.Path, "/file/"):
		handleFile(w, r)
	case r.URL.Path == "/proxy":
		handleProxy(w, r)
	default:
		writeJSON(w, http.StatusNotFound, map[string]string{
			"error": "not found",
			"path":  r.URL.Path,
		})
	}
}

func handleConfig(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPost {
		var patch map[string]any
		if err := json.NewDecoder(r.Body).Decode(&patch); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"success": false, "error": "Invalid config payload", "detail": err.Error()})
			return
		}
		for key, value := range patch {
			configState[key] = value
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "config": configState})
}

func handleSaveCache(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "Method not allowed"})
		return
	}
	var payload struct {
		ID       string `json:"id"`
		Content  string `json:"content"`
		Category string `json:"category"`
		Ext      string `json:"ext"`
		Type     string `json:"type"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"success": false, "error": "Invalid save payload", "detail": err.Error()})
		return
	}
	category := sanitizeSegment(payload.Category, "history")
	id := sanitizeSegment(payload.ID, fmt.Sprintf("cache-%d", time.Now().UnixMilli()))
	ext := sanitizeSegment(strings.TrimPrefix(payload.Ext, "."), "jpg")
	if ext == "jpg" && payload.Type == "video" {
		ext = "mp4"
	}
	content, err := decodeCacheContent(payload.Content)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"success": false, "error": "Decode cache content failed", "detail": err.Error()})
		return
	}
	relPath := filepath.ToSlash(filepath.Join(category, id+"."+ext))
	outputPath := filepath.Join(cacheRoot, filepath.FromSlash(relPath))
	if err := os.MkdirAll(filepath.Dir(outputPath), 0755); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"success": false, "error": "Create cache directory failed", "detail": err.Error()})
		return
	}
	if err := os.WriteFile(outputPath, content, 0644); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"success": false, "error": "Write cache file failed", "detail": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"url":     fmt.Sprintf("http://127.0.0.1:%d/file/%s", port, encodeRelPath(relPath)),
		"path":    outputPath,
		"relPath": relPath,
	})
}

func handleFile(w http.ResponseWriter, r *http.Request) {
	rel, err := url.PathUnescape(strings.TrimPrefix(r.URL.Path, "/file/"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid file path"})
		return
	}
	rel = strings.TrimLeft(filepath.ToSlash(rel), "/")
	target := filepath.Clean(filepath.Join(cacheRoot, filepath.FromSlash(rel)))
	if target != cacheRoot && !strings.HasPrefix(target, cacheRoot+string(os.PathSeparator)) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "Forbidden"})
		return
	}
	data, err := os.ReadFile(target)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "File not found"})
		return
	}
	applyCORS(w.Header())
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
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

func getCacheRoot() string {
	if raw := strings.TrimSpace(os.Getenv("VODSTUDIO_CACHE_DIR")); raw != "" {
		if abs, err := filepath.Abs(raw); err == nil {
			return abs
		}
		return raw
	}
	cwd, err := os.Getwd()
	if err != nil {
		return "vodstudio-cache"
	}
	return filepath.Join(cwd, "vodstudio-cache")
}

func sanitizeSegment(value, fallback string) string {
	raw := strings.ReplaceAll(strings.ReplaceAll(value, "\\", "-"), "/", "-")
	safe := safeSegmentPattern.ReplaceAllString(raw, "-")
	safe = strings.Trim(safe, "-")
	if len(safe) > 120 {
		safe = safe[:120]
	}
	if safe == "" {
		return fallback
	}
	return safe
}

func decodeCacheContent(content string) ([]byte, error) {
	if !strings.HasPrefix(content, "data:") {
		return []byte(content), nil
	}
	parts := strings.SplitN(content, ",", 2)
	if len(parts) != 2 {
		return nil, fmt.Errorf("invalid data url")
	}
	if strings.Contains(parts[0], ";base64") {
		return base64.StdEncoding.DecodeString(parts[1])
	}
	decoded, err := url.QueryUnescape(parts[1])
	if err != nil {
		return nil, err
	}
	return []byte(decoded), nil
}

func encodeRelPath(relPath string) string {
	parts := strings.Split(filepath.ToSlash(relPath), "/")
	for i, part := range parts {
		parts[i] = url.PathEscape(part)
	}
	return strings.Join(parts, "/")
}

func listCacheFiles() []string {
	files := []string{}
	_ = filepath.WalkDir(cacheRoot, func(path string, entry os.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return nil
		}
		rel, relErr := filepath.Rel(cacheRoot, path)
		if relErr == nil {
			files = append(files, filepath.ToSlash(rel))
		}
		return nil
	})
	return files
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
