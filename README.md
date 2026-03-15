# Versie — Git made invisible for vibe coders

You're building with Cursor, Windsurf, Claude, or any AI coding tool. Your tool keeps mentioning Git. You don't know what any of it means and you just want to build.

Versie handles all of it for you.

---

## The idea

Most vibe coders push straight to their live app every time they save. That means every experiment, every half-finished feature, every broken change goes live immediately. One bad save and your app is down.

Versie separates your work from what's live:

- **Save as much as you want** — your live app doesn't change
- **Say "ship it"** — your live app updates cleanly
- **Say "go back to [anything]"** — Versie restores it

No Git knowledge required. No branches to manage. No commands to memorize.

---

## Install — 2 minutes

**Option A — Automatic (recommended):**

```
npx versie-mcp --install
```

Then restart your AI tool. Versie will introduce itself the next time you open a project.

**Option B — Manual:**

Add one entry to your MCP client config:

```json
{
  "mcpServers": {
    "versie": {
      "command": "npx",
      "args": ["-y", "versie-mcp"]
    }
  }
}
```

| Tool | Config file location |
|------|---------------------|
| Cursor | Settings → MCP → Edit config |
| Claude Desktop | Settings → Developer → Edit config |
| Windsurf | Cascade → Configure MCP |
| Claude Code | `~/.claude.json` |

Then restart your AI tool.

---

## What you can say

Versie understands plain English. You don't need to remember exact commands.

| Say something like... | What happens |
|---|---|
| *"Save my work"* | Your progress is saved. Live app unchanged. |
| *"Ship it"* | Everything saved since you last shipped goes live. |
| *"Save and ship"* | Saves and ships in one step. |
| *"What have I changed?"* | See what's new since your last save. |
| *"What's not live yet?"* | See what's saved but not yet shipped. |
| *"Go back to yesterday"* | Restore to any previous version. |
| *"Go back to the live version"* | Undo everything back to what's live. |
| *"Create a checkpoint called mvp"* | Bookmark this moment by name. |
| *"Check my project health"* | Full status: saves, ships, any issues. |
| *"What can Versie do?"* | See all available commands. |
| *"Help with shipping setup"* | Configure Vercel, Netlify, Railway, or GitHub Actions. |

---

## How the dev/live model works

When you first use Versie, it quietly sets up two tracks for your project:

**Your workspace** — where all your saves go. Experiment freely here. Break things. Try things. Nothing here affects your live app.

**What's live** — only updates when you explicitly say "ship it." This is what your users see.

You never have to think about this. You'll never hear the words "branch" or "merge." Versie just handles it.

```
You say "save my work"
→ Progress saved. Live app unchanged. ✓

You say "ship it"
→ Live app updates with everything since you last shipped. ✓

You say "go back to last Tuesday"
→ Restored. Live app unchanged. ✓
```

---

## Free vs Pro

| Feature | Free | Pro |
|---------|------|-----|
| All 10 operations | ✓ | ✓ |
| Error fixing (15 patterns) | ✓ | ✓ |
| Named checkpoints | 5 | Unlimited |
| Works across sessions | ✓ | ✓ |
| Visual timeline + one-click deploy | — | ✓ |

Pro is a subscription — see [versie.co](https://versie.co) for current pricing and details.

---

## Using the MCP server and skill together

Don't install both in the same tool at the same time. They do the same thing — if both are active, every operation runs twice (two saves, two ships, duplicate tags).

Pick one:
- **MCP server** — any MCP-compatible tool, works across sessions, recommended
- **Skill** — Claude Code or Claude Desktop only, no config needed

If you're switching from the skill, remove the `versie` folder from `.claude/skills/` before adding the MCP config.

---

## Before you use "ship it"

Versie ships by pushing to your main branch. For this to update your live app, your shipping platform needs to be watching main — and main only.

Vercel users: you're already protected by default. If you're on Netlify, Railway, Render, or using GitHub Actions, confirm that only your main branch triggers a live update. If it's set to all branches, Versie's workspace saves will go live too, breaking the separation.

Say "help with shipping setup" inside your AI tool and Versie will walk you through it for your specific platform.

---

## Help & feedback

Something not working? Email [support@versie.co](mailto:support@versie.co) and we'll sort it out.

---

## Disclaimer

Versie is an MCP server that tells your AI tool to run standard Git commands on your behalf — the same commands any developer would run manually.

**You are responsible for reviewing what runs on your system.** Versie will always describe what it is about to do before doing it. Some operations — like restoring to a previous version — are destructive by design. Versie creates automatic snapshots before any destructive operation, but it is your responsibility to maintain backups of any data you cannot afford to lose.

This software is provided **as-is, with no warranty of any kind**. The author is not liable for data loss, broken deployments, or any other issues arising from use of this software. By using Versie, you accept that Git operations carry inherent risk and that you are running them voluntarily on your own systems.

See the [AGPL-3.0 License](LICENSE) for full terms.

---

## License

GNU Affero General Public License v3.0 (AGPL-3.0) — free to use and modify; any modified version you deploy must also be open source under the same license.

---

Versie is a product of [Z12 Ventures](https://z12ventures.com).
