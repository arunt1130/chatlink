# chatlink: shared memory for your Claude chats

chatlink lets two or more people's Claude Desktop chats share one memory. You keep chatting in your own Claude Desktop, and Claude can tell you what the others said, for example: *"Krish already ruled caching out on Nov 3: 'Caching won't help here: every query has a unique timestamp in it.'"*

- Everything you share is saved **word for word**, with who said it and when, in a private GitHub repo you all clone. Nothing is summarized behind your back.
- Each person writes only their own folder. Sync is plain `git pull` / `git push` with your own git login.
- Search runs on your computer. There's no server, no API key and no account to create.

You need: **Claude Desktop** (Windows or macOS), **git**, and a **GitHub** account. About 10 minutes.

---

## 1. One person: create the shared repo

1. On github.com: **+** → **New repository**. Give it a name (e.g. `our-chatlink`), choose **Private**, and **don't** add a README, .gitignore or license, so it starts empty. Click **Create repository**.
2. **Settings → Collaborators → Add people**, and add everyone else by GitHub username. They'll get an email invite and must **accept** it.

## 2. Everyone: get git and sign in to GitHub

chatlink runs git in the background, where it can't type a password, so git must be able to reach GitHub on its own. You set that up once.

**Windows**
1. Install git from [git-scm.com/download/win](https://git-scm.com/download/win) (the default options are fine; they include *Git Credential Manager*, which handles GitHub sign-in).
2. Open **PowerShell** and check that it works: `git --version` prints a version.

**macOS**
1. Open **Terminal** and run `git --version`. If macOS offers to install the *command line developer tools*, click **Install** and wait for it to finish, then run `git --version` again.
2. Install GitHub CLI from [cli.github.com](https://cli.github.com) (the *Download for Mac* button), then run these two commands and follow the prompts (choose *GitHub.com*, *HTTPS*, and *Login with a web browser*):

```bash
gh auth login
```

```bash
gh auth setup-git
```

**If Claude Desktop was open while you installed git, quit it fully and reopen it**, so it can find git.

## 3. Everyone: clone the repo (outside OneDrive / Dropbox / iCloud)

File-sync tools can corrupt git folders, so put the clone directly in your home folder. Replace `OWNER/REPO` with the repo's path, e.g. `arun/our-chatlink`.

**Windows** (PowerShell). A browser window may open to sign in to GitHub the first time; do it.

```bash
git clone https://github.com/OWNER/REPO.git "$HOME\chatlink-space"
```

**macOS** (Terminal):

```bash
git clone https://github.com/OWNER/REPO.git ~/chatlink-space
```

Cloning an empty repo prints "You appear to have cloned an empty repository". That's fine.

**Check that git can reach GitHub without asking.** This should finish quietly, printing nothing or a line of letters and numbers, and never ask for a username or password:

```bash
git -C "$HOME/chatlink-space" ls-remote origin
```

If it asks for anything, finish the sign-in from step 2 and try again.

## 4. Everyone: install the extension

1. Get **`chatlink.mcpb`** (about 120 MB). Whoever set this up sends it to you, for example with a Google Drive or OneDrive share link.
2. Double-click it, or in Claude Desktop go to **Settings → Extensions** and drag the file in (or use *Install extension…*).
3. Claude Desktop asks for two things:
   - **Your name**: lowercase, e.g. `arun`. It's your folder in the shared repo. Each person, and each computer, needs its own name (see "Good to know").
   - **Your clone of the shared repo**: the `chatlink-space` folder from step 3.
4. Make sure the extension is **enabled**.

The first time it runs, chatlink sets up the shared repo (its `.gitignore`, `.gitattributes` and `space.json`) if nobody has yet, and builds its local search index.

## 5. Everyone: make a Project for shared work

In Claude Desktop: **Projects → New project**. Then open the project's **instructions** and paste:

```
Shared memory rules:
- At the start of every reply, call sync_turn with my message copied verbatim, before you answer.
- When something from another person is relevant, name them, give the date, and quote their own words.
- Be exact about trust: "Krish marked this closed" is different from "Krish said something related". Never present a plain message or a model-written note as someone's decision.
- If sync_turn flags a possible decision, ask me in one line whether to mark it.
- If I say "off the record", call sync_turn with share=false for that message.
- If sync state says results may be stale, mention it once.
```

Chat inside that project whenever you want the shared memory. Chats outside it aren't shared.

## 6. Try it

1. **Person A**, in the project: *"Caching won't help here: every query has a unique timestamp in it."*
   The first time, Claude Desktop asks to allow `sync_turn`. Choose **Allow** (or "Always allow").
2. **Person B**, a few seconds later, in their project: *"Should we cache the query results?"*
   Claude should name person A, give the date, and quote their words.

Other things you can say:
- *"Catch me up"*, or use the **catch_me_up** prompt: what the others added since you last looked.
- *"Off the record: …"*: nothing is saved or shared.
- *"Let's drop the caching idea."*: Claude asks whether to mark it **closed**. Say yes, and everyone sees it as confirmed.
- *"Remember for everyone: deploys are frozen until Monday."*: saves a note.

## 7. Optional: bring in an older chat

1. On claude.ai: **Settings → Privacy → Export data**. You'll get an email with a zip; unzip it to find `conversations.json`.
2. In your chatlink project, tell Claude: *"Import my old chat from C:\Users\me\Downloads\export\conversations.json, the conversation called 'API performance'."* (On macOS use a path like `/Users/me/Downloads/export/conversations.json`.)

Your side of the chat is imported word for word, marked as *imported*. Claude's replies are left out unless you ask for them. Running the same import again adds nothing new. A plain text file with `Human:` / `Assistant:` labels also works.

## Good to know

- **Offline?** It keeps working. Your messages are saved locally and delivered next time, and Claude mentions once that results may be stale.
- **Trust levels:** *confirmed* (someone marked or noted it) > *said* (a plain message) > *imported* > *model-written* (never anyone's position).
- **One name per computer.** Each chatlink install needs its own clone and its **own name**. Two computers using the same name would both write the same files, and their syncing would get stuck. If you use two computers, pick names like `arun` and `arun-laptop`; your teammates will see both.
- **Where things live:** messages are in `chatlink-space/logs/<name>/` (plain JSON Lines; open them in any text editor). Your local index and read position are in `%LOCALAPPDATA%\chatlink` (Windows) or `~/Library/Application Support/chatlink` (macOS). Deleting those is safe: they're rebuilt.
- **Something wrong?** Claude Desktop → **Settings → Developer → Open Logs Folder**, file `mcp-server-chatlink*.log`. Common causes: git can't reach GitHub without a prompt (see steps 2–3), git was installed while Claude Desktop was open (quit and reopen it), or the clone is in OneDrive. If it says another chatlink process is using the clone and nothing else is running, delete the file it names (`.git/chatlink-server.pid` in your clone) and restart Claude Desktop.

---

## For developers

TypeScript on Node. [SPEC.md](SPEC.md) is the source of truth, [DECISIONS.md](DECISIONS.md) records the choices, and [CLAUDE.md](CLAUDE.md) has the workflow.

```bash
npm ci
```

```bash
npm run fetch-model
```

```bash
npm test
```

```bash
npm run pack
```

- `npm run fetch-model`: downloads the embedding model once (~130 MB, hash-checked) into `models/`.
- `npm test`: runs the test suite offline.
- `npm run pack`: builds `dist/chatlink.mcpb` (it runs `@anthropic-ai/mcpb` through npx).
- `node dist/cli.js import|rebuild|search …`: command-line tools; quit Claude Desktop first.
- [docs/m3-desktop-test.md](docs/m3-desktop-test.md): try two "people" on one machine with a local test repo.
