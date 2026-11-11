package server

import (
	"encoding/json"
	"math"
	"strconv"
	"strings"
	"time"
)

func emptyState() map[string]any {
	return map[string]any{
		"version": 1, "teams": []any{}, "questions": []any{}, "currentQuestionId": nil,
		"rebuttalOpen": false, "buzzerOpensAt": nil, "buzzerTeamId": nil,
		"buzzerTieTeamIds": []any{}, "screen": "question", "updatedAt": time.Now().UnixMilli(),
	}
}

func validateState(state map[string]any) []string {
	issues := make([]string, 0)
	if numberValue(state["version"]) != 1 {
		issues = append(issues, "Versi state harus 1.")
	}
	teams := arrayValue(state["teams"])
	if teams == nil || len(teams) > 100 {
		issues = append(issues, "teams harus berupa array dengan maksimal 100 tim.")
	}
	questions := arrayValue(state["questions"])
	if questions == nil || len(questions) > 5000 {
		issues = append(issues, "questions harus berupa array dengan maksimal 5000 soal.")
	}
	if _, ok := state["rebuttalOpen"].(bool); !ok {
		issues = append(issues, "rebuttalOpen harus berupa boolean.")
	}
	if screen := stringValue(state["screen"]); screen != "question" && screen != "standby" {
		issues = append(issues, "screen harus bernilai question atau standby.")
	}
	if value, ok := state["buzzerOpensAt"]; ok && value != nil && !finite(value) {
		issues = append(issues, "buzzerOpensAt harus berupa angka atau null.")
	}
	if len(issues) > 0 {
		return issues
	}

	teamIDs := make(map[string]bool)
	for index, raw := range teams {
		team, ok := raw.(map[string]any)
		if !ok {
			issues = append(issues, "teams["+itoa(index)+"] harus berupa objek.")
			continue
		}
		id := stringValue(team["id"])
		if !validText(id, 128) || teamIDs[id] {
			issues = append(issues, "teams["+itoa(index)+"].id harus unik dan tidak kosong.")
		}
		teamIDs[id] = true
		if !validText(stringValue(team["name"]), 100) {
			issues = append(issues, "teams["+itoa(index)+"].name wajib diisi (maksimal 100 karakter).")
		}
		if !finite(team["score"]) || numberValue(team["score"]) < 0 {
			issues = append(issues, "teams["+itoa(index)+"].score harus berupa angka nol atau lebih.")
		}
		if sound, ok := team["soundData"].(string); !ok || len(sound) > 3_000_000 {
			issues = append(issues, "teams["+itoa(index)+"].soundData harus berupa string maksimal 3 MB.")
		}
	}

	questionIDs := make(map[string]bool)
	for index, raw := range questions {
		question, ok := raw.(map[string]any)
		if !ok {
			issues = append(issues, "questions["+itoa(index)+"] harus berupa objek.")
			continue
		}
		id := stringValue(question["id"])
		if !validText(id, 128) || questionIDs[id] {
			issues = append(issues, "questions["+itoa(index)+"].id harus unik dan tidak kosong.")
		}
		questionIDs[id] = true
		if group, ok := question["group"].(string); !ok || len(group) > 120 {
			issues = append(issues, "questions["+itoa(index)+"].group harus berupa teks maksimal 120 karakter.")
		}
		if len(stringValue(question["group"])) > 120 {
			issues = append(issues, "questions["+itoa(index)+"].group harus berupa teks maksimal 120 karakter.")
		}
		if !validText(stringValue(question["text"]), 4000) {
			issues = append(issues, "questions["+itoa(index)+"].text wajib diisi (maksimal 4000 karakter).")
		}
		if _, ok := question["answer"].(string); !ok || len(stringValue(question["answer"])) > 1000 {
			issues = append(issues, "questions["+itoa(index)+"].answer harus berupa teks maksimal 1000 karakter.")
		}
		if !finite(question["value"]) || numberValue(question["value"]) < 0 {
			issues = append(issues, "questions["+itoa(index)+"].value harus berupa angka nol atau lebih.")
		}
	}
	if value := state["currentQuestionId"]; value != nil && !questionIDs[stringValue(value)] {
		issues = append(issues, "currentQuestionId harus menunjuk ke soal yang tersedia.")
	}
	if value := state["buzzerTeamId"]; value != nil && !teamIDs[stringValue(value)] {
		issues = append(issues, "buzzerTeamId harus menunjuk ke tim yang tersedia.")
	}
	if value, ok := state["buzzerTieTeamIds"]; ok && value != nil {
		ties, ok := value.([]any)
		if !ok || len(ties) > 100 {
			issues = append(issues, "buzzerTieTeamIds harus berupa array ID tim.")
		} else {
			for _, id := range ties {
				if _, ok := id.(string); !ok || !teamIDs[stringValue(id)] {
					issues = append(issues, "buzzerTieTeamIds harus menunjuk ke tim yang tersedia.")
					break
				}
			}
		}
	}
	raw, _ := json.Marshal(state)
	if len(raw) > 5*1024*1024 {
		issues = append(issues, "Ukuran total state melebihi 5 MB.")
	}
	return issues
}

func containsTeam(raw any, id string) bool {
	for _, item := range arrayValue(raw) {
		if team, ok := item.(map[string]any); ok && stringValue(team["id"]) == id {
			return true
		}
	}
	return false
}

func arrayValue(value any) []any {
	items, _ := value.([]any)
	return items
}

func boolValue(value any) bool {
	result, _ := value.(bool)
	return result
}

func finite(value any) bool {
	number, ok := value.(float64)
	return ok && !math.IsNaN(number) && !math.IsInf(number, 0)
}

func numberValue(value any) float64 {
	number, _ := value.(float64)
	return number
}

func stringValue(value any) string {
	text, _ := value.(string)
	return text
}

func validText(value string, max int) bool {
	return strings.TrimSpace(value) != "" && len(value) <= max
}

func itoa(value int) string {
	return strconv.Itoa(value)
}
