package main

import (
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"net/http"
	"strings"
)

func handleAvatar(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/avatars/")
	id = strings.TrimSpace(id)
	if id == "" || strings.Contains(id, "/") || strings.Contains(id, "..") {
		http.NotFound(w, r)
		return
	}
	img := critterFace(id)
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "public, max-age=86400")
	_ = png.Encode(w, img)
}

func critterFace(id string) image.Image {
	sum := sha1.Sum([]byte(id))
	hexID := hex.EncodeToString(sum[:])
	_ = hexID
	hue := int(sum[0])
	sat := 40 + int(sum[1])%40
	light := 45 + int(sum[2])%20
	body := hsl(hue, sat, light)
	eye := color.RGBA{R: 20, G: 24, B: 32, A: 255}
	accent := hsl((hue+40)%360, sat, light+15)

	const size = 32
	img := image.NewRGBA(image.Rect(0, 0, size, size))
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			img.Set(x, y, color.RGBA{R: 12, G: 16, B: 24, A: 255})
		}
	}
	for y := 6; y < 26; y++ {
		for x := 6; x < 26; x++ {
			dx := x - 16
			dy := y - 16
			if dx*dx+dy*dy <= 81 {
				img.Set(x, y, body)
			}
		}
	}
	img.Set(11, 14, eye)
	img.Set(12, 14, eye)
	img.Set(19, 14, eye)
	img.Set(20, 14, eye)
	for x := 12; x <= 19; x++ {
		img.Set(x, 20, accent)
	}
	return img
}

func hsl(h, s, l int) color.RGBA {
	hf := float64(h % 360)
	sf := float64(s) / 100
	lf := float64(l) / 100
	c := (1 - absFloat(2*lf-1)) * sf
	x := c * (1 - absFloat(modFloat(hf/60, 2)-1))
	m := lf - c/2
	var r, g, b float64
	switch {
	case hf < 60:
		r, g, b = c, x, 0
	case hf < 120:
		r, g, b = x, c, 0
	case hf < 180:
		r, g, b = 0, c, x
	case hf < 240:
		r, g, b = 0, x, c
	case hf < 300:
		r, g, b = x, 0, c
	default:
		r, g, b = c, 0, x
	}
	return color.RGBA{
		R: uint8((r + m) * 255),
		G: uint8((g + m) * 255),
		B: uint8((b + m) * 255),
		A: 255,
	}
}

func absFloat(v float64) float64 {
	if v < 0 {
		return -v
	}
	return v
}

func modFloat(a, b float64) float64 {
	return a - b*float64(int(a/b))
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	if err := enc.Encode(v); err != nil {
		fmt.Fprintf(w, `{"error":%q}`, err.Error())
	}
}
