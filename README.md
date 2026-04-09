# Versie — Git made invisible for non-technical builders

You're building with Cursor, Windsurf, Claude, or any AI coding tool. Your tool keeps mentioning Git. You don't know what any of it means and you just want to build.

Versie handles all of it for you.

---

## The idea

Most non-technical builders push straight to their live app every time they save. That means every experiment, every half-finished feature, every broken change goes live immediately. One bad save and your app is down.

Versie separates your work from what's live:

- **Save as much as you want** — your live app doesn't change
- **Say "ship it"** — your live app updates cleanly
- **Say "go back to [anything]"** — Versie restores it

No Git knowledge required. No branches to manage. No commands to memorize.

---

## Install — 2 minutes

**Option A — Automatic (recommended):**

```
npx versie-cli --install
```

This installs the `versie` command globally and configures your AI tool (Cursor, Claude Code, Windsurf, Claude Desktop) in one step. Restart your AI tool when it's done.

**Option B — Two steps:**

```
npm install -g versie-cli
versie --install
```

Then restart your AI tool.

**Option C — Manual MCP config:**

Add this to your MCP client config if you prefer to configure it yourself:

```json
{
  "mcpServers": {
    "versie": {
      "command": "npx",
      "args": ["-y", "versie-cli"]
    }
  }
}
```

> **Note for nvm users:** If your AI tool launches with a minimal PATH (Claude Desktop, Cursor, Windsurf), replace `"npx"` with the full path to your npx binary — e.g. `/Users/you/.nvm/versions/node/v20.0.0/bin/npx`. Run `which npx` in your terminal to find it.

| Tool | Config file location |
|------|---------------------|
| Cursor | Settings → MCP → Edit config |
| Claude Desktop | Settings → Developer → Edit config |
| Windsurf | Cascade → Configure MCP |
| Claude Code | `~/.claude.json` |

---

## First-time setup

After installing, open a project in your AI tool and say:

> **"set up versie"**

Versie will initialize your workspace and connect to GitHub. Your live app won't change until you explicitly ship.

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
| *"Go back to my last snapshot"* | Undo a previous restore — brings back your backed-up work. |
| *"Create a checkpoint called mvp"* | Bookmark this moment by name. |
| *"Check my project health"* | Full status: saves, ships, any issues. |
| *"What can Versie do?"* | See all available commands. |
| *"Help with shipping setup"* | Configure Vercel, Netlify, Railway, or GitHub Actions. |

---

## CLI commands

Versie also installs a `versie` terminal command. Your AI tool calls these automatically — but you can run them yourself too.

```
versie save [message]                 Save your current work
versie save-and-ship [description]    Save and ship live in one step
versie ship "<release notes>"         Ship saved work live
versie checkpoint [name]              Create a named checkpoint to return to
versie status                         Show what's changed since last save
versie go-back <target>               Go back to a checkpoint
versie timeline [limit]               Show save, checkpoint, and ship history
versie health                         Check project setup
versie setup [github-url]             First-time project setup
versie login                          Connect to the Versie dashboard
versie deploy-help [platform]         Configure Vercel, Netlify, Railway, or Render
versie config show-git-commands on|off  Toggle showing underlying git commands
versie config telemetry on|off        Toggle anonymous telemetry
versie fix "error message"            Diagnose and fix a git error
versie remove [--yes]                 Remove this project from the Versie dashboard
versie uninstall                      Remove Versie from your AI tools
```

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

## How it works under the hood

Versie is a **CLI + MCP hybrid**:

- **CLI (`versie` command)** — handles all mechanical operations: save, ship, go-back, checkpoint, status, setup, deploy-help, config, and more. Your AI tool calls these as bash commands, which is fast and uses very few tokens.
- **MCP server** — handles one AI-reasoning operation: `fix_this_error` (pattern-matched error diagnosis). This stays as an MCP tool because multi-line error messages are passed reliably as structured input rather than bash arguments.

Both the CLI and MCP server share the same underlying logic. Installing `versie-cli` gives you both.

---

## Connecting to the Versie dashboard

Run this in your terminal to link your projects to the Versie web dashboard:

```
versie login
```

This opens a browser window to authenticate with your Versie account. Once approved, your saves and ships sync to the dashboard automatically.

To connect from inside your AI tool, say: **"connect versie to the dashboard"** — it will run `versie login` for you.

---

## Privacy & telemetry

Versie collects anonymous usage data by default — which commands you use and whether error fixes succeed. No personal information, no file contents, no repo names. This data is used to improve error detection patterns.

To opt out per project, say: **"turn off telemetry"** in your AI tool. To opt out globally across all projects, set `VERSIE_TELEMETRY=false` in your environment.

---

## Free vs Pro

| Feature | Free | Pro |
|---------|------|-----|
| All core operations | ✓ | ✓ |
| Error fixing (15 patterns) | ✓ | ✓ |
| Named checkpoints | Unlimited | Unlimited |
| Works across sessions | ✓ | ✓ |
| Works with any AI tool | ✓ | ✓ |
| Visual timeline + one-click rollback | — | ✓ |
| Deploy tracking (Vercel, GitHub Actions) | — | ✓ |
| Ship notifications (email) | — | ✓ |

Pro is a subscription — see [versie.co](https://versie.co) for current pricing.

---

## Using Versie with the Claude Skill

Don't install both the CLI and the Claude Skill in the same tool at the same time. They do the same thing — if both are active, every operation runs twice.

Pick one:
- **versie-cli** — any MCP-compatible tool, works across sessions, recommended
- **Skill** — Claude Code or Claude Desktop only, no config needed, no terminal required

If you're switching from the skill, remove the `versie` folder from `.claude/skills/` before installing the CLI.

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

Versie runs standard Git commands on your behalf — the same commands any developer would run manually.

**You are responsible for reviewing what runs on your system.** Versie will always describe what it is about to do before doing it. Some operations — like restoring to a previous version — are destructive by design. Versie creates automatic snapshots before any destructive operation, but it is your responsibility to maintain backups of any data you cannot afford to lose.

This software is provided **as-is, with no warranty of any kind**. The author is not liable for data loss, broken deployments, or any other issues arising from use of this software. By using Versie, you accept that Git operations carry inherent risk and that you are running them voluntarily on your own systems.

See the [AGPL-3.0 License](LICENSE) for full terms.

---

## License

GNU Affero General Public License v3.0 (AGPL-3.0) — free to use and modify; any modified version you deploy must also be open source under the same license.

---

Versie is a product of [Z12 Ventures](https://z12ventures.com).
