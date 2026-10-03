import QtQuick

// TEMPORARY CHARACTER — LOCAL TESTING ONLY. DO NOT PUBLISH.
//
// A QML Canvas port of "Mochi" from Coucou (github.com/Louis-CFM/coucou,
// windows/src/mochi/engine.ts). The Coucou *code* is MIT, but the Mochi
// character design is reserved by its author (see LICENSE-ASSETS.md in that
// repo): it may not be distributed in another app without written permission.
// It stands in until agent-fold has its own character; replace this file
// (or point FloatingBuddy's `character` at another file) before any release.
//
// Character contract (any file in characters/ must provide these):
//   property string mood   idle | working | thinking | approval | question
//                          | error | ratelimit | finished | sleeping
//   property real lookX    -1 (left) … 1 (right); where the eyes point
//   property real lookY    -1 (up) … 1 (down)
//   property bool running  false pauses the frame loop
//   function poke()        reaction to a click
Item {
  id: root

  property string mood: "idle"
  property real lookX: 0
  property real lookY: 0
  property bool running: true

  implicitWidth: 96
  implicitHeight: 96

  function poke() { engine.squash(); engine.blink() }

  onMoodChanged: engine.setState(mood)
  Component.onCompleted: engine.setState(mood, true)

  QtObject {
    id: engine

    readonly property real eyeW: 0.25
    readonly property real eyeH: 0.27
    readonly property real eyeSpacing: 0.37
    readonly property real eyePitch: -0.12
    readonly property var baseTop: [0.929, 0.929, 0.937]
    readonly property var baseBottom: [0.769, 0.773, 0.792]
    readonly property string ink: "rgb(26,20,18)"

    readonly property var palette: ({
      idle: [0.902, 0.914, 0.933],
      working: [0.231, 0.62, 1],
      thinking: [0.545, 0.361, 0.965],
      approval: [0.961, 0.647, 0.141],
      question: [0.133, 0.827, 0.933],
      error: [0.957, 0.314, 0.369],
      finished: [0.204, 0.831, 0.6],
      ratelimit: [0.984, 0.573, 0.235],
      sleeping: [0.58, 0.635, 0.722]
    })

    // eye, tint, badge, and motion flags per mood (BOT_STATES in engine.ts).
    readonly property var states: ({
      idle: { tint: 0, eye: "pill", badge: "" },
      working: { tint: 0.72, eye: "pill", badge: "dots" },
      thinking: { tint: 0.72, eye: "pill", badge: "dots", look: [0.55, 0.55] },
      approval: { tint: 0.78, eye: "wide", badge: "bang", bounces: true },
      question: { tint: 0.75, eye: "pill", badge: "question", tilt: 0.17 },
      error: { tint: 0.78, eye: "flat", badge: "dot" },
      ratelimit: { tint: 0.72, eye: "tired", badge: "dot", sweat: true },
      finished: { tint: 0.35, eye: "happy", badge: "dot" },
      sleeping: { tint: 0.32, eye: "closed", badge: "", breathes: true, zz: true }
    })

    // Animated values. Kept in one plain object so a frame doesn't fire a
    // property-change signal per field.
    property var s: ({
      yaw: 0, pitch: 0, roll: 0, tilt: 0, open: 1, sx: 1, sy: 1, oy: 0, ox: 0,
      tint: 0, badgeS: 0, col: [0.902, 0.914, 0.933], colT: [0.902, 0.914, 0.933]
    })
    property var cfg: states.idle
    property string state: ""
    property string badge: ""
    property var badgeColor: palette.idle
    property var tweens: ({})
    property var particles: []
    property real clock: Math.random() * 5
    property real nextBlink: 1.5 + Math.random() * 2
    property real lastAmbient: 0

    function easeOut(t) { return 1 - Math.pow(1 - t, 3) }
    function easeInOut(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2 }
    function easeBack(t) { var c1 = 1.7, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2) }
    function lerp(a, b, t) { return a + (b - a) * t }

    // keys: [[target, durationMs, ease], ...] played in order.
    function anim(prop, keys, done) {
      tweens[prop] = { keys: keys, index: 0, from: s[prop], start: clock * 1000, done: done || null }
    }

    function setState(next, force) {
      if (!states[next]) next = "idle"
      if (state === next && !force) return
      var previous = state
      state = next
      cfg = states[next]
      s.colT = palette[next]
      s.tint = cfg.tint
      setBadge(cfg.badge, palette[next])

      if (next === "finished") {
        anim("roll", [[Math.PI * 2, 950, easeInOut]], function() { s.roll = 0 })
        emitLater("spark", 5, 500)
      } else if (next === "error") {
        anim("ox", [[0.08, 50, easeOut], [-0.08, 70, easeInOut], [0.05, 70, easeInOut], [0, 90, easeOut]])
      } else if (next === "approval") {
        anim("oy", [[-0.2, 150, easeOut], [0, 300, easeBack]])
      } else if (next === "ratelimit") {
        emit("sweat", 1)
      } else if (previous !== "") {
        blink()
      }
    }

    function setBadge(kind, color) {
      if (kind === badge && String(color) === String(badgeColor)) return
      anim("badgeS", [[0, 90, easeInOut]], function() {
        badge = kind
        badgeColor = color
        if (kind !== "") anim("badgeS", [[1, 280, easeBack]])
      })
    }

    function blink() { anim("open", [[0.06, 70, easeInOut], [1, 130, easeOut]]) }

    function squash() {
      anim("sy", [[0.78, 70, easeOut], [1.1, 130, easeOut], [1, 170, easeInOut]])
      anim("sx", [[1.16, 70, easeOut], [0.95, 130, easeOut], [1, 170, easeInOut]])
    }

    function emitLater(type, count, delayMs) {
      particles.push({ type: "delay", fire: type, count: count, age: -delayMs / 1000, life: 0 })
    }

    function emit(type, count) {
      for (var i = 0; i < count; i++) {
        var isZ = type === "z"
        particles.push({
          type: type,
          x: (Math.random() - 0.5) * 0.9 + (isZ ? 0.55 : 0),
          y: -0.7 - Math.random() * 0.2,
          vx: (Math.random() - 0.5) * 0.35 + (isZ ? 0.18 : 0),
          vy: -(0.45 + Math.random() * 0.35),
          age: -i * 0.14,
          life: 1.3 + Math.random() * 0.5,
          rot: Math.random() * Math.PI * 2,
          size: 0.15 + Math.random() * 0.08
        })
      }
    }

    function update(dt) {
      dt = Math.min(dt, 0.1)
      clock += dt
      var nowMs = clock * 1000

      for (var prop in tweens) {
        var tw = tweens[prop]
        var key = tw.keys[tw.index]
        var p = Math.min(1, Math.max(0, (nowMs - tw.start) / key[1]))
        s[prop] = tw.from + (key[0] - tw.from) * key[2](p)
        if (p >= 1) {
          tw.from = key[0]
          tw.index++
          tw.start = nowMs
          if (tw.index >= tw.keys.length) {
            delete tweens[prop]
            if (tw.done) tw.done()
          }
        }
      }

      var t = clock
      var ty = root.lookX * 0.62
      var tp = root.lookY * 0.5
      if (cfg.look) {
        ty = ty * 0.35 + cfg.look[0] * 0.55
        tp = tp * 0.3 + cfg.look[1] * 0.5
      }
      if (state === "sleeping") { ty = 0; tp = -0.14 }

      var kGen = 1 - Math.pow(0.0008, dt)
      var kLook = 1 - Math.pow(0.0025, dt)
      var bounce = cfg.bounces ? -Math.abs(Math.sin(t * 5.2)) * 0.07 : 0
      if (!tweens.oy) s.oy += (bounce - s.oy) * kGen

      var tgSy = 1, tgSx = 1
      if (cfg.breathes) {
        tgSy = 1 + Math.sin(t * 1.8) * 0.035
        tgSx = 1 - Math.sin(t * 1.8) * 0.02
      }
      if (!tweens.yaw) s.yaw += (ty - s.yaw) * kLook
      if (!tweens.pitch) s.pitch += (tp - s.pitch) * kLook
      if (!tweens.tilt) s.tilt += ((cfg.tilt || 0) - s.tilt) * kGen
      if (!tweens.sy) s.sy += (tgSy - s.sy) * kGen
      if (!tweens.sx) s.sx += (tgSx - s.sx) * kGen

      var kCol = 1 - Math.pow(0.002, dt)
      s.col = [lerp(s.col[0], s.colT[0], kCol), lerp(s.col[1], s.colT[1], kCol), lerp(s.col[2], s.colT[2], kCol)]

      if (t > nextBlink) {
        if (state !== "sleeping") {
          blink()
          if (Math.random() < 0.22) emitLater("blink", 0, 230)
        }
        nextBlink = t + 2.2 + Math.random() * 3.2
      }

      if (t - lastAmbient > 1.3) {
        lastAmbient = t
        if (cfg.zz) emit("z", 1)
        if (cfg.sweat && Math.random() < 0.5) emit("sweat", 1)
      }

      var alive = []
      for (var i = 0; i < particles.length; i++) {
        var particle = particles[i]
        particle.age += dt
        if (particle.type === "delay") {
          if (particle.age < 0) alive.push(particle)
          else if (particle.fire === "blink") blink()
          else emit(particle.fire, particle.count)
        } else if (particle.age < particle.life) {
          alive.push(particle)
        }
      }
      particles = alive
    }

    function rgba(c, a) {
      return "rgba(" + Math.round(c[0] * 255) + "," + Math.round(c[1] * 255) + "," + Math.round(c[2] * 255) + "," + (a === undefined ? 1 : a) + ")"
    }

    function roundRect(ctx, x, y, w, h, r) {
      r = Math.max(0, Math.min(r, w / 2, h / 2))
      ctx.beginPath()
      ctx.moveTo(x + r, y)
      ctx.arcTo(x + w, y, x + w, y + h, r)
      ctx.arcTo(x + w, y + h, x, y + h, r)
      ctx.arcTo(x, y + h, x, y, r)
      ctx.arcTo(x, y, x + w, y, r)
      ctx.closePath()
    }

    function starPath(ctx, ro, ri) {
      ctx.beginPath()
      for (var i = 0; i < 10; i++) {
        var r = i % 2 ? ri : ro
        var a = -Math.PI / 2 + (i * Math.PI) / 5
        if (i === 0) ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r)
        else ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r)
      }
      ctx.closePath()
    }

    // Superellipse "squircle" body.
    function bodyPath(ctx, rx, ry) {
      var n = 72
      var expN = 2.0 / 2.7
      ctx.beginPath()
      for (var i = 0; i <= n; i++) {
        var a = (i / n) * Math.PI * 2
        var ca = Math.cos(a), sa = Math.sin(a)
        var px = rx * (ca >= 0 ? Math.pow(ca, expN) : -Math.pow(-ca, expN))
        var py = ry * (sa >= 0 ? Math.pow(sa, expN) : -Math.pow(-sa, expN))
        if (i === 0) ctx.moveTo(px, py)
        else ctx.lineTo(px, py)
      }
      ctx.closePath()
    }

    function draw(ctx, W, H) {
      ctx.reset()
      var R = W * 0.3
      var rx = R * 1.14
      var ry = R * 0.88
      var cx = W / 2 + s.ox * R
      var cy = H / 2 + s.oy * R + R * 0.06

      ctx.save()
      ctx.translate(cx, cy)
      if (s.tilt !== 0) ctx.rotate(s.tilt)
      ctx.scale(s.sx, s.sy)

      // Body: base gradient, mood tint from below, edge shade, highlight.
      var g = ctx.createLinearGradient(rx * 0.7, -ry * 0.85, -rx * 0.8, ry * 0.9)
      g.addColorStop(0, rgba(baseTop))
      g.addColorStop(1, rgba(baseBottom))
      bodyPath(ctx, rx, ry)
      ctx.fillStyle = g
      ctx.fill()

      if (s.tint > 0.01) {
        var tg = ctx.createLinearGradient(0, ry, 0, -ry)
        tg.addColorStop(0, rgba(s.col, 0.72 * s.tint))
        tg.addColorStop(1, rgba(s.col, 0))
        ctx.fillStyle = tg
        ctx.fill()
      }

      var sh = ctx.createRadialGradient(0, 0, R * 0.15, 0, 0, R * 1.25)
      sh.addColorStop(0, "rgba(0,0,0,0)")
      sh.addColorStop(0.6, "rgba(0,0,0,0)")
      sh.addColorStop(1, "rgba(0,0,0,0.2)")
      ctx.fillStyle = sh
      ctx.fill()

      var hl = ctx.createRadialGradient(rx * 0.34, -ry * 0.46, 0, rx * 0.34, -ry * 0.46, R * 0.42)
      hl.addColorStop(0, "rgba(255,255,255,0.55)")
      hl.addColorStop(1, "rgba(255,255,255,0)")
      ctx.fillStyle = hl
      ctx.fill()

      ctx.save()
      ctx.clip()

      var blush = s.tint * 0.5
      if (blush > 0.01) {
        var yOffset = Math.sin(s.yaw) * rx * 0.8
        ctx.fillStyle = "rgba(255,120,150," + (0.5 * blush) + ")"
        for (var side = -1; side <= 1; side += 2) {
          var bx = side * rx * 0.55 + yOffset
          ctx.beginPath()
          ctx.ellipse(bx - R * 0.17, ry * 0.2 - R * 0.1, R * 0.34, R * 0.2)
          ctx.fill()
        }
      }

      drawEyes(ctx, R, rx, ry)
      ctx.restore()
      ctx.restore()

      if (badge !== "" && s.badgeS > 0.01) drawBadge(ctx, R, cx, cy)
      drawParticles(ctx, R, cx, cy)
    }

    function drawEyes(ctx, R, rx, ry) {
      ctx.fillStyle = ink
      ctx.strokeStyle = ink
      for (var sd = -1; sd <= 1; sd += 2) {
        var eyeYaw = sd * eyeSpacing + s.yaw
        var eyePitchNow = eyePitch + s.pitch + s.roll
        eyePitchNow = (((eyePitchNow + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) - Math.PI
        var cp = Math.cos(eyePitchNow)
        if (Math.cos(eyeYaw) * cp <= 0.04) continue

        var ex = Math.sin(eyeYaw) * cp * rx
        var ey = -Math.sin(eyePitchNow) * ry
        var fx = Math.max(0.18, Math.cos(eyeYaw))
        var fy = Math.max(0.18, cp)
        ctx.save()
        ctx.translate(ex, ey)
        ctx.scale(fx, fy)
        drawEyeShape(ctx, cfg.eye, R * eyeW, R * eyeH)
        ctx.restore()
      }
    }

    function drawEyeShape(ctx, shape, w, h) {
      if (shape === "wide") {
        drawEyeShape(ctx, "pill", w * 1.16, h * 1.12)
      } else if (shape === "pill") {
        var hh = Math.max(h * s.open, w * 0.3)
        roundRect(ctx, -w / 2, -hh / 2, w, hh, Math.min(w / 2, hh / 2))
        ctx.fill()
      } else if (shape === "flat") {
        roundRect(ctx, -w * 0.72, -w * 0.2, w * 1.44, w * 0.4, w * 0.2)
        ctx.fill()
      } else if (shape === "happy") {
        ctx.lineWidth = w * 0.5
        ctx.lineCap = "round"
        ctx.beginPath()
        ctx.arc(0, h * 0.18, w * 0.82, Math.PI * 1.12, Math.PI * 1.88, false)
        ctx.stroke()
      } else if (shape === "closed") {
        ctx.lineWidth = w * 0.36
        ctx.lineCap = "round"
        ctx.beginPath()
        ctx.arc(0, -h * 0.08, w * 0.78, Math.PI * 0.15, Math.PI * 0.85, false)
        ctx.stroke()
      } else if (shape === "tired") {
        roundRect(ctx, -w / 2, -h * 0.02, w, h * 0.38, w / 2)
        ctx.fill()
        roundRect(ctx, -w * 0.62, -h * 0.1, w * 1.24, w * 0.22, w * 0.11)
        ctx.fill()
      }
    }

    function drawBadge(ctx, R, cx, cy) {
      var bs = s.badgeS
      var t = clock
      var col = rgba(badgeColor)
      ctx.save()
      ctx.translate(cx - R * 0.72 * s.sx, cy - R * 0.72 * s.sy)
      ctx.scale(bs, bs)
      if (badge === "dots") {
        var pw = R * 0.72, ph = R * 0.36
        roundRect(ctx, -pw / 2, -ph / 2, pw, ph, ph / 2)
        ctx.fillStyle = col
        ctx.fill()
        for (var i = 0; i < 3; i++) {
          var phase = (((t * 2.4 - i * 0.22) % 1) + 1) % 1
          var dotR = R * 0.055 * (1 + 0.4 * Math.max(0, Math.sin(phase * Math.PI * 2)))
          ctx.fillStyle = "#fff"
          ctx.beginPath()
          ctx.arc((i - 1) * R * 0.18, 0, dotR, 0, Math.PI * 2, false)
          ctx.fill()
        }
      } else if (badge === "bang" || badge === "question") {
        ctx.fillStyle = "#000"
        ctx.beginPath()
        ctx.arc(0, 0, R * 0.3, 0, Math.PI * 2, false)
        ctx.fill()
        ctx.fillStyle = col
        ctx.beginPath()
        ctx.arc(0, 0, R * 0.23, 0, Math.PI * 2, false)
        ctx.fill()
        ctx.fillStyle = "#fff"
        ctx.font = "bold " + Math.round(R * 0.32) + "px sans-serif"
        ctx.textAlign = "center"
        ctx.textBaseline = "middle"
        ctx.fillText(badge === "bang" ? "!" : "?", 0, R * 0.02)
      } else {
        ctx.fillStyle = "#000"
        ctx.beginPath()
        ctx.arc(0, 0, R * 0.2, 0, Math.PI * 2, false)
        ctx.fill()
        ctx.fillStyle = col
        ctx.beginPath()
        ctx.arc(0, 0, R * 0.135, 0, Math.PI * 2, false)
        ctx.fill()
      }
      ctx.restore()
    }

    function drawParticles(ctx, R, cx, cy) {
      for (var i = 0; i < particles.length; i++) {
        var p = particles[i]
        if (p.type === "delay" || p.age <= 0) continue
        var k = p.age / p.life
        var a = k < 0.2 ? k / 0.2 : 1 - (k - 0.2) / 0.8
        var sz = R * p.size * (1 + k * 0.4)
        ctx.save()
        ctx.translate(cx + (p.x + p.vx * p.age) * R * 1.3, cy + (p.y + p.vy * p.age) * R * 1.3)
        ctx.globalAlpha = Math.min(1, Math.max(0, a))
        if (p.type === "spark") {
          ctx.rotate(p.rot)
          ctx.fillStyle = "#fff"
          starPath(ctx, sz * 0.8, sz * 0.18)
          ctx.fill()
        } else if (p.type === "sweat") {
          ctx.fillStyle = "#7CC7FF"
          ctx.beginPath()
          ctx.moveTo(0, -sz)
          ctx.quadraticCurveTo(sz * 0.8, sz * 0.2, 0, sz * 0.6)
          ctx.quadraticCurveTo(-sz * 0.8, sz * 0.2, 0, -sz)
          ctx.fill()
        } else if (p.type === "z") {
          ctx.fillStyle = "rgb(209,219,235)"
          ctx.font = "bold " + Math.max(1, Math.round(sz * 1.9)) + "px sans-serif"
          ctx.textAlign = "center"
          ctx.textBaseline = "middle"
          ctx.fillText("z", 0, 0)
        }
        ctx.restore()
      }
    }
  }

  Canvas {
    id: canvas
    anchors.fill: parent
    renderStrategy: Canvas.Cooperative
    onPaint: engine.draw(getContext("2d"), width, height)
  }

  FrameAnimation {
    running: root.running && root.visible
    onTriggered: {
      engine.update(frameTime)
      canvas.requestPaint()
    }
  }
}
