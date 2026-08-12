const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const sessionHudHtml = fs.readFileSync(path.join(__dirname, "..", "src", "session-hud.html"), "utf8");
const sessionHudRenderer = fs.readFileSync(path.join(__dirname, "..", "src", "session-hud-renderer.js"), "utf8");
const quotaRingHtml = fs.readFileSync(path.join(__dirname, "..", "src", "quota-ring.html"), "utf8");
const quotaRingRenderer = fs.readFileSync(path.join(__dirname, "..", "src", "quota-ring-renderer.js"), "utf8");

describe("session HUD is sessions-only (quota moved to the ring)", () => {
  it("no longer renders an account-quota strip inside the HUD", () => {
    assert.doesNotMatch(sessionHudRenderer, /buildQuotaStrip/);
    assert.doesNotMatch(sessionHudRenderer, /createQuotaMeter/);
    assert.doesNotMatch(sessionHudHtml, /\.quota-strip/);
    assert.doesNotMatch(sessionHudHtml, /\.quota-window-fill/);
  });
});

describe("pet-attached quota ring", () => {
  it("draws one coin per provider with up to two concentric rings (outer/inner window)", () => {
    assert.match(quotaRingRenderer, /buildCoinSvg/);
    assert.match(quotaRingRenderer, /OUTER_R/);
    assert.match(quotaRingRenderer, /INNER_R/);
    // Fill sweeps with the selected display percentage, clockwise from 12 o'clock.
    assert.match(quotaRingRenderer, /rotate\(-90/);
    assert.match(quotaRingRenderer, /stroke-dasharray/);
  });

  // A healthy ring is colored by identity, not by headroom: severity has only
  // three steps, so two healthy windows used to come out the same color and read
  // as one thick ring. Severity still owns the alert states.
  it("gives every ring provider its own identity pair, so none silently wears another's colors", () => {
    // The generic --id-outer/--id-inner pair is Claude's, by design (it is the
    // most common coin). That makes a missing pair invisible rather than loud:
    // a new provider would just look like Claude. Pin the mapping instead.
    const declared = new Set(
      [...quotaRingHtml.matchAll(/--id-([a-z]+)-(outer|inner)\s*:/g)].map((m) => `${m[1]}-${m[2]}`)
    );
    // RING_PROVIDERS keys are "<name>Quota"; the CSS classes are pv-<key>.
    const providerKeys = [...quotaRingRenderer.matchAll(/key:\s*"(\w+Quota)"/g)].map((m) => m[1]);
    assert.ok(providerKeys.length >= 3, `expected the ring providers, got ${providerKeys}`);
    for (const key of providerKeys) {
      const name = key.replace(/Quota$/, "").toLowerCase();
      for (const slot of ["outer", "inner"]) {
        assert.ok(
          declared.has(`${name}-${slot}`),
          `${key} has no --id-${name}-${slot} in quota-ring.html; it would inherit the generic (Claude) pair`
        );
        assert.match(
          quotaRingHtml,
          new RegExp(`\\.pv-${key}\\.rg-${slot}\\s*\\{[^}]*--ring-id`),
          `${key}/${slot} resolves no --ring-id, so fill and track would not share a hue`
        );
      }
    }
  });

  // The track is the same hue as the fill, laid down faintly. A reset ring draws
  // no fill at all, so the track is the only thing left on screen — it must not
  // fall back to grey there, which is why it carries the identity classes too.
  it("beds every track in its own ring's hue, fill and track from one source", () => {
    assert.match(quotaRingRenderer, /ringCircle\(`track \$\{identityClass\(/);
    // Scope the assertions to the track rule itself. Matching the whole file
    // would let the identical fallback on .fill.sev-ok satisfy them while the
    // track quietly lost its own (a mutation run caught exactly that).
    const trackRule = quotaRingHtml.match(/\.coin \.track\.rg-outer,[\s\S]*?\n\}/);
    assert.ok(trackRule, "no .coin .track.rg-outer rule found");
    assert.match(trackRule[0], /color-mix\(in srgb, var\(--ring-id/);
    assert.match(trackRule[0], /var\(--track-alpha\), transparent\)/);
    // An invalid color-mix resolves to `unset` -> stroke's initial `none`, which
    // would erase the ring; the var() fallback is what prevents that.
    assert.match(trackRule[0], /var\(--ring-id,\s*var\(--id-outer\)\)/);
    // Exactly one --ring-track declaration: a duplicate silently shadows the
    // other and the comment stops describing what ships.
    assert.strictEqual((quotaRingHtml.match(/^\s*--ring-track\s*:/gm) || []).length, 1);
  });

  it("colors coins by severity and dims reset/stale states", () => {
    assert.match(quotaRingRenderer, /severityClass/);
    assert.match(quotaRingHtml, /\.fill\.sev-ok/);
    assert.match(quotaRingHtml, /\.fill\.sev-warn/);
    assert.match(quotaRingHtml, /\.fill\.sev-hot/);
    assert.match(quotaRingHtml, /\.fill\.sev-reset/);
    assert.match(quotaRingHtml, /\.fill\.sev-reset\s*\{[^}]*opacity:\s*0\.56/);
    assert.match(quotaRingHtml, /is-stale/);
    // Expired data is normalized to zero used; remaining mode renders that as
    // a weak full ring without inheriting the pre-reset severity or pulse.
    assert.match(quotaRingRenderer, /usedPercent: 0, expired: true/);
    assert.match(quotaRingRenderer, /outer\.reset \? "sev-reset"/);
  });

  it("labels windows from reporter metadata, never hard-coding 5h/7d", () => {
    assert.match(quotaRingRenderer, /formatWindowLabel/);
    assert.match(quotaRingRenderer, /windowMinutes/);
    assert.match(quotaRingRenderer, /minutes \/ \(24 \* 60\)/);
  });

  it("keeps the ring compact without hover cards and reuses provider agent icons", () => {
    assert.doesNotMatch(quotaRingRenderer, /coinTooltip/);
    assert.doesNotMatch(quotaRingRenderer, /mouseenter|mouseleave/);
    assert.doesNotMatch(quotaRingRenderer, /\.title\s*=/);
    assert.match(quotaRingRenderer, /quotaDisplayPercent/);
    assert.match(quotaRingRenderer, /quotaAgentIcons/);
  });

  it("clicking a coin or the overflow opens the Dashboard", () => {
    assert.match(quotaRingRenderer, /openDashboard\(\)/);
    assert.match(quotaRingRenderer, /buildOverflow/);
  });

  it("does not advertise unreachable keyboard controls in the non-focusable ring panel", () => {
    assert.match(quotaRingHtml, /id="cluster"[^>]*aria-hidden="true"/);
    assert.doesNotMatch(quotaRingRenderer, /tabindex/);
    assert.doesNotMatch(quotaRingRenderer, /addEventListener\("keydown"/);
    assert.doesNotMatch(quotaRingRenderer, /setAttribute\("role", "button"\)/);
  });

  it("honors reduced motion for the near-exhausted pulse", () => {
    assert.match(quotaRingHtml, /prefers-reduced-motion: reduce/);
    assert.match(quotaRingHtml, /coin-pulse/);
  });
});

describe("session HUD visual shell", () => {
  it("adds asymmetric body padding so the shadow has more room below than above", () => {
    assert.match(sessionHudHtml, /body\s*\{[\s\S]*padding:\s*2px 3px 8px;[\s\S]*\}/);
    assert.match(sessionHudHtml, /\.hud\s*\{[\s\S]*width:\s*100%;[\s\S]*height:\s*100%;[\s\S]*\}/);
    assert.doesNotMatch(sessionHudHtml, /\.hud\s*\{[\s\S]*width:\s*240px;[\s\S]*\}/);
  });

  it("keeps the rounded card while switching to a bottom-biased shadow", () => {
    assert.match(sessionHudHtml, /\.hud\s*\{[\s\S]*border-radius:\s*8px;[\s\S]*\}/);
    assert.match(sessionHudHtml, /\.hud\s*\{[\s\S]*box-shadow:\s*0 8px 18px -12px var\(--shadow\),\s*0 2px 4px rgba\(0,\s*0,\s*0,\s*0\.10\);[\s\S]*\}/);
    assert.doesNotMatch(sessionHudHtml, /\.hud\s*\{[\s\S]*box-shadow:\s*0 4px 14px var\(--shadow\);[\s\S]*\}/);
    assert.match(sessionHudHtml, /\.hud\s*\{[\s\S]*background:\s*var\(--hud-bg\);[\s\S]*\}/);
  });

  it("reserves row-level space for the auto-hide pin button", () => {
    assert.match(sessionHudHtml, /\.hud\.has-pin\s+\.row\s*\{[\s\S]*padding-right:\s*28px;[\s\S]*\}/);
    assert.doesNotMatch(sessionHudHtml, /\.hud\.has-pin\s+\.row\s+\.right\s*\{[\s\S]*padding-right:/);
  });

  it("marks non-focusable HUD sessions without attempting terminal focus", () => {
    assert.match(sessionHudHtml, /\.row-unfocusable\s*\{[\s\S]*cursor:\s*default;[\s\S]*\}/);
    assert.match(sessionHudHtml, /\.focus-unavailable\s*\{[\s\S]*width:\s*13px;[\s\S]*\}/);
    assert.match(sessionHudRenderer, /session\.canFocus\s*===\s*true/);
    assert.match(sessionHudRenderer, /row\.classList\.add\("row-unfocusable"\)/);
    assert.match(sessionHudRenderer, /window\.sessionHudAPI\.focusSession\(session\.id\);/);
  });

  it("renders transient feedback inline instead of covering fixed-height rows", () => {
    assert.match(sessionHudHtml, /\.session-inline-feedback\s*\{/);
    assert.doesNotMatch(sessionHudHtml, /\.session-action-feedback\s*\{/);
    assert.match(sessionHudRenderer, /SESSION_ACTION_FEEDBACK_MS\s*=\s*4000/);
    assert.match(sessionHudRenderer, /title\.className = feedbackText \? "title session-inline-feedback"/);
  });

  it("renders state labels without replacing unread completed-session bells", () => {
    assert.match(sessionHudHtml, /\.state-chip\s*\{/);
    assert.match(sessionHudHtml, /\.chip-working\s*\{/);
    assert.match(sessionHudHtml, /\.chip-worktree\s*\{/);
    assert.match(sessionHudHtml, /\.completion-bell\s*\{/);
    assert.match(sessionHudRenderer, /const STATE_CHIP_MAP\s*=/);
    assert.match(sessionHudRenderer, /const EVENT_CHIP_MAP\s*=/);
    assert.match(sessionHudRenderer, /PermissionRequest:\s*\{ key: "sessionNotification"/);
    assert.match(sessionHudRenderer, /PreCompact:\s*\{ key: "sessionSweeping"/);
    assert.match(sessionHudRenderer, /WorktreeCreate:\s*\{ key: "sessionWorktree"/);
    assert.match(sessionHudRenderer, /session\.badge === "done" && unreadSessions\.has\(session\.id\)/);
    assert.match(sessionHudRenderer, /bell\.className = "completion-bell unread-bell"/);
    assert.match(sessionHudRenderer, /RECENT_DONE_UNREAD_MS\s*=\s*60 \* 1000/);
    assert.match(sessionHudRenderer, /prev === undefined[\s\S]{0,180}unreadSessions\.add\(session\.id\)/);
    assert.doesNotMatch(sessionHudRenderer, /sessionBadgeDone[\s\S]{0,80}chip-done/);
    assert.doesNotMatch(sessionHudRenderer, /sessionCarrying/);
  });

  it("marks startup-restored live sessions without using a completion chip", () => {
    assert.match(sessionHudHtml, /\.chip-recovered\s*\{/);
    assert.match(sessionHudRenderer, /session\.startupRecovered/);
    assert.match(sessionHudRenderer, /t\("sessionRecovered"\)/);
    assert.doesNotMatch(sessionHudRenderer, /startupRecovered[\s\S]{0,120}sessionBadgeDone/);
  });

  it("uses a compact HUD-only title without mutating the full session title", () => {
    assert.match(sessionHudRenderer, /HUD_TITLE_MAX_UNITS\s*=\s*15/);
    assert.match(sessionHudRenderer, /function shortenHudTitle\(value\)/);
    assert.match(sessionHudRenderer, /title\.textContent = feedbackText \|\| shortTitle/);
    assert.match(sessionHudRenderer, /title\.title = fullTitle/);
  });

  it("updates elapsed labels without rebuilding animated rows every second", () => {
    assert.match(sessionHudRenderer, /function updateElapsedLabels\(\)/);
    assert.match(sessionHudRenderer, /elapsed\.className = "elapsed"/);
    assert.match(sessionHudRenderer, /setInterval\(updateElapsedLabels, 1000\)/);
    assert.doesNotMatch(sessionHudRenderer, /setInterval\(render, 1000\)/);
  });

  it("keeps context usage chips visible before truncating elapsed text", () => {
    // Flexbox quirk regression guard: overflow:hidden gives a flex item an
    // AUTOMATIC minimum size of 0, so without an explicit min-content floor
    // .right shrinks below its chips under squeeze and its own overflow
    // clipping cuts them mid-glyph. The elapsed span keeps min-width: 0 so it
    // contributes nothing to that floor and truncates first.
    assert.match(sessionHudHtml, /\.right\s*\{[\s\S]*?flex:\s*0 1 auto;[\s\S]*?max-width:\s*58%;[\s\S]*?min-width:\s*min-content;[\s\S]*?overflow:\s*hidden;[\s\S]*?\}/);
    const rightBlock = sessionHudHtml.match(/\.right\s*\{[\s\S]*?\}/);
    assert.ok(rightBlock, "session-hud.html should define a .right rule");
    assert.doesNotMatch(rightBlock[0], /min-width:\s*0\b/, ".right must not zero its width floor");
    assert.match(sessionHudHtml, /\.elapsed\s*\{[\s\S]*min-width:\s*0;[\s\S]*text-overflow:\s*ellipsis;[\s\S]*\}/);
    assert.match(sessionHudHtml, /\.usage-chip\s*\{[\s\S]*flex:\s*0 0 auto;[\s\S]*white-space:\s*nowrap;[\s\S]*\}/);
  });

  it("honors reduced motion for HUD animations", () => {
    assert.match(sessionHudHtml, /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*\.dot-running\s*\{[\s\S]*animation:\s*none;/);
    assert.match(sessionHudHtml, /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*\.unread-bell svg\s*\{[\s\S]*animation:\s*none;/);
  });
});
