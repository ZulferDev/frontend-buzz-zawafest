package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"zawa-smart-competition/backend-go/internal/server"
)

func main() {
	port := requiredIntEnv("PORT", 3000, 1, 65535)
	frontendPort := requiredIntEnv("FRONTEND_PORT", 5173, 1, 65535)
	startDelay := time.Duration(requiredIntEnv("BUZZER_START_DELAY_MS", 2000, 0, 30000)) * time.Millisecond
	host := env("HOST", "0.0.0.0")
	databasePath := env("SQLITE_PATH", "../backend/data/zawa.sqlite")
	origins := splitOrigins(os.Getenv("FRONTEND_ORIGINS"))

	service, err := server.New(server.Config{
		DatabasePath:     databasePath,
		FrontendPort:     frontendPort,
		AllowedOrigins:   origins,
		BuzzerStartDelay: startDelay,
	})
	if err != nil {
		log.Fatal(err)
	}
	defer service.Close()

	httpServer := &http.Server{
		Addr:              host + ":" + strconv.Itoa(port),
		Handler:           service,
		ReadHeaderTimeout: 5 * time.Second,
	}

	log.Printf("ZAWA Go backend listening on http://%s", httpServer.Addr)
	log.Printf("SQLite database: %s", databasePath)
	shutdownContext, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-shutdownContext.Done()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(ctx)
	}()
	if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}

func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func requiredIntEnv(key string, fallback, minimum, maximum int) int {
	raw := os.Getenv(key)
	if raw == "" {
		return fallback
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < minimum || value > maximum {
		log.Fatalf("%s must be an integer between %d and %d", key, minimum, maximum)
	}
	return value
}

func splitOrigins(value string) []string {
	var origins []string
	for _, origin := range strings.Split(value, ",") {
		if trimmed := strings.TrimSpace(origin); trimmed != "" {
			origins = append(origins, trimmed)
		}
	}
	if len(origins) == 0 {
		return []string{"http://localhost:5173", "http://127.0.0.1:5173"}
	}
	return origins
}
