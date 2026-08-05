# Slack App Icon

Use the existing Invoker logo asset when setting the Slack app's real avatar.

The canonical source logo is:

```text
packages/app/assets/icons/source/invoker-logo.png
```

Ready-made PNG renditions are available under:

```text
packages/app/assets/icons/png/
```

Slack app icons want a square image at least 512x512 pixels. Use this rendition for the app icon upload:

```text
packages/app/assets/icons/png/512x512.png
```

## Manual Update Path

1. Open `https://api.slack.com/apps`.
2. Select the Invoker app.
3. Go to `Settings`.
4. Open `Basic Information`.
5. In `Display Information`, find `App icon`.
6. Upload `packages/app/assets/icons/png/512x512.png`.
7. Save the change.

## Automation Constraint

Slack does not provide an API or app manifest field for setting the real app avatar. This means the app icon upload cannot be automated by repository code, Slack app manifests, or deployment scripts.

Slack does support per-message `icon_url` overrides, but those were explicitly not chosen for Invoker. The intended result is the bot's real Slack app avatar, set manually through the Slack dashboard.
