import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const linux = path.join(root, "scripts/linux");
const units = ["kleinbot-signal-cli", "kleinbot-signal", "kleinbot-whatsapp"];
const placeholders = ["BOT_USER", "BOT_GROUP", "BOT_HOME", "WRAPPER_DIR", "RUNTIME", "CHECKOUT", "FLAGS_SIGNAL", "FLAGS_WHATSAPP"];
const settings = {
  BOT_USER: "kleinbot", BOT_GROUP: "kleinbot", BOT_HOME: "/home/kleinbot",
  RUNTIME: "/srv/kleinbot/runtime", WRAPPER_DIR: "/usr/local/lib/kleinbot", CHECKOUT: "/srv/kleinbot/checkout",
  FLAGS_SIGNAL: "/srv/kleinbot/signal", FLAGS_WHATSAPP: "/srv/kleinbot/whatsapp",
  FLAGS_GROUP: "",
};

function bash(script: string, args: string[] = [], env: NodeJS.ProcessEnv = {}) {
  return spawnSync("bash", ["-euc", script, "test", ...args], {
    cwd: root, encoding: "utf8", env: { ...process.env, ...settings, ...env },
  });
}

function temporary(run: (dir: string) => void) {
  const dir = fs.mkdtempSync(path.join(root, ".linux-test-"));
  try { run(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function render(unit: string) {
  const result = bash('source "$1/unit-tools.sh"; validate_settings; render_unit "$1/$2.service"', [linux, unit]);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

describe("Linux system install", () => {
  it("keeps root mutations out of bot-controlled runtime paths", () => {
    const installer = fs.readFileSync(path.join(linux, "install.sh"), "utf8");
    assert.doesNotMatch(installer, /\$RUNTIME\/bin|--trust-checkout/);
    for (const line of installer.split("\n")) {
      if (!/\b(?:install -d|chown|chmod)\b/.test(line) || !/\$(?:RUNTIME|BOT_HOME)\b/.test(line)) continue;
      // The home entry alone is stable because its parent is protected.
      if (line === 'chmod 700 "$BOT_HOME"') {
        assert.ok(installer.indexOf("check_root_path /home") < installer.indexOf(line));
        assert.ok(installer.indexOf('stat -c %F -- "$BOT_HOME"') < installer.indexOf(line));
        assert.ok(installer.indexOf('refuse_symlinks "$BOT_HOME"') < installer.indexOf(line));
      } else {
        assert.match(line, /runuser -u "\$BOT_USER" --|sudo -u/);
      }
    }
    assert.match(installer, /runuser -u "\$BOT_USER" -- install -d -m 2770 "\$p\/\$sub"/);
    assert.ok(installer.indexOf("trap '") < installer.indexOf("$(mktemp"));
    assert.ok(installer.indexOf('check_flags_parent "$p"') < installer.indexOf('install -d -o "$BOT_USER"'));
    assert.ok(installer.indexOf('stat -c %u -- "$p"') < installer.indexOf('. "$HERE/unit-tools.sh"'));
  });

  it("checks stages, private env files, and flags parents without root privileges", () => {
    assert.notEqual(process.getuid?.(), 0, "run filesystem checks as an unprivileged user");
    temporary(dir => {
      const uid = String(process.getuid!());
      const check = (fn: string, file: string, extra: string[] = []) =>
        bash(`source "$1/unit-tools.sh"; ${fn} "$2" "\${@:3}"`, [linux, file, ...extra]);
      const stage = path.join(dir, "stage");
      fs.mkdirSync(stage, { mode: 0o775 });
      for (const name of ["install.sh", "run-daemon.sh", "unit-tools.sh", ...units.map(unit => `${unit}.service`)]) {
        fs.copyFileSync(path.join(linux, name), path.join(stage, name));
        // Explicit modes: a checkout made under umask 0002 has 664 files, and the
        // stage check would then name install.sh instead of the file this test targets.
        fs.chmodSync(path.join(stage, name), 0o644);
      }
      fs.chmodSync(stage, 0o775);
      const writableStage = check("check_stage", stage);
      assert.notEqual(writableStage.status, 0);
      assert.match(writableStage.stderr, /stage directory: .*writable by group\/others/);
      fs.chmodSync(stage, 0o755);
      fs.chmodSync(path.join(stage, "unit-tools.sh"), 0o664);
      const writableHelper = check("check_stage", stage);
      assert.notEqual(writableHelper.status, 0);
      assert.match(writableHelper.stderr, /untrusted stage file: .*unit-tools.sh/);
      fs.chmodSync(path.join(stage, "unit-tools.sh"), 0o644);
      assert.notEqual(check("check_stage", stage).status, 0, "a privately owned stage is still untrusted");

      const file = path.join(dir, "daemon.env");
      fs.writeFileSync(file, "", { mode: 0o600 });
      assert.equal(check("check_env_file", file, [uid]).status, 0);
      const backup = path.join(dir, "backup");
      fs.linkSync(file, backup);
      assert.equal(check("check_env_file", file, [uid]).status, 0, "hard-linked backups are allowed");
      fs.chmodSync(file, 0o640);
      assert.notEqual(check("check_env_file", file, [uid]).status, 0);
      fs.chmodSync(file, 0o600);
      assert.notEqual(check("check_env_file", file, ["0"]).status, 0);
      const link = path.join(dir, "linked.env");
      fs.symlinkSync(file, link);
      assert.notEqual(check("check_env_file", link, [uid]).status, 0);
      fs.unlinkSync(link);
      fs.symlinkSync(path.join(dir, "missing"), link);
      assert.notEqual(check("check_env_file", link, [uid]).status, 0);
      fs.symlinkSync(dir, path.join(dir, "alias"));
      assert.notEqual(check("check_env_file", path.join(dir, "alias/daemon.env"), [uid]).status, 0);

      assert.notEqual(check("check_flags_parent", path.join(dir, "flags"), [uid]).status, 0);
      assert.equal(check("check_flags_parent", "/usr/unused-flags", [uid]).status, 0);
      fs.chmodSync(dir, 0o777);
      assert.notEqual(check("check_flags_parent", path.join(dir, "flags"), [uid]).status, 0);
    });
  });

  it("refuses --start until claude, signal-cli and tsx exist, and warns without a Claude token", () => {
    temporary(dir => {
      const home = path.join(dir, "home"), checkout = path.join(dir, "checkout"), runtime = path.join(dir, "runtime");
      const ready = () => bash('source "$1/unit-tools.sh"; check_start_ready "$2" "$3" "$4"', [linux, home, checkout, runtime],
        { READY_SYSTEM_BIN_DIRS: "" });
      const executable = (file: string) => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, "#!/bin/sh\n", { mode: 0o755 });
      };
      fs.mkdirSync(path.join(runtime, "config"), { recursive: true });
      let result = ready();
      assert.notEqual(result.status, 0);
      for (const name of [/claude/, /signal-cli/, /tsx/, /CLAUDE_CODE_OAUTH_TOKEN/]) assert.match(result.stderr, name);

      executable(path.join(home, ".local/bin/claude"));
      executable(path.join(home, ".local/bin/signal-cli"));
      executable(path.join(checkout, "node_modules/.bin/tsx"));
      result = ready();
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, /warning: no CLAUDE_CODE_OAUTH_TOKEN/);

      fs.writeFileSync(path.join(runtime, "config/daemon.env"), "ANTHROPIC_API_KEY=invented\n", { mode: 0o600 });
      assert.equal(ready().stderr, "", "an API key also authenticates");
      fs.writeFileSync(path.join(runtime, "config/daemon.env"), "CLAUDE_CODE_OAUTH_TOKEN=invented\n", { mode: 0o600 });
      result = ready();
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");

      // A configured SIGNAL_CLI_BIN (quoted, CRLF) replaces the default location.
      const custom = path.join(dir, "custom signal-cli");
      fs.writeFileSync(path.join(runtime, "config/.env"), `SIGNAL_CLI_BIN="${custom}"\r\n`, { mode: 0o600 });
      result = ready();
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /signal-cli '.*custom signal-cli'/);
      executable(custom);
      assert.equal(ready().status, 0);

      const env = (text: string) => fs.writeFileSync(path.join(runtime, "config/.env"), text, { mode: 0o600 });
      // A bare SIGNAL_CLI_BIN is looked up on the unit PATH, as the wrapper's exec does.
      env("SIGNAL_CLI_BIN=signal-cli\n");
      assert.equal(ready().status, 0, ready().stderr);
      // An empty SIGNAL_CLI_BIN is kept by the wrapper and cannot run.
      env("SIGNAL_CLI_BIN=\n");
      assert.notEqual(ready().status, 0);
      // daemon.env wins over .env, first occurrence wins.
      fs.writeFileSync(path.join(runtime, "config/daemon.env"),
        "CLAUDE_CODE_OAUTH_TOKEN=invented\nexport SIGNAL_CLI_BIN='signal-cli'\nSIGNAL_CLI_BIN=\n", { mode: 0o600 });
      assert.equal(ready().status, 0, ready().stderr);
      // A relative path resolves against the checkout (the units' working directory).
      fs.writeFileSync(path.join(runtime, "config/daemon.env"), "CLAUDE_CODE_OAUTH_TOKEN=invented\nSIGNAL_CLI_BIN=bin/sc\n", { mode: 0o600 });
      assert.notEqual(ready().status, 0);
      executable(path.join(checkout, "bin/sc"));
      assert.equal(ready().status, 0, ready().stderr);

      // CLAUDE_BIN is what the bot runs: a working custom command passes without a claude,
      // and a broken one fails even when claude is installed. Empty means claude.
      env("CLAUDE_BIN=" + path.join(dir, "missing-model") + "\n");
      result = ready();
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /missing-model/);
      env("CLAUDE_BIN=\n");
      assert.equal(ready().status, 0);
      fs.rmSync(path.join(home, ".local/bin/claude"));
      const model = path.join(dir, "model");
      executable(model);
      env(`CLAUDE_BIN=${model}\n`);
      assert.equal(ready().status, 0, ready().stderr);
      env("");

      fs.mkdirSync(path.join(home, ".local/bin/claude"));
      assert.notEqual(ready().status, 0, "a directory named claude is not an executable");
    });
  });

  it("runs the start preflight before any change when --start is given", () => {
    const installer = fs.readFileSync(path.join(linux, "install.sh"), "utf8");
    const preflight = installer.indexOf('check_start_ready "$HERE" "$BOT_HOME" "$CHECKOUT" "$RUNTIME"');
    assert.match(installer, /runuser -u "\$BOT_USER" -- bash -c '\. "\$1\/unit-tools\.sh"; check_start_ready/, "the preflight runs as the bot");
    assert.ok(preflight > 0);
    for (const mutation of ["groupadd", "useradd", "install -d", "systemctl"]) {
      assert.ok(preflight < installer.indexOf(mutation), `preflight must precede ${mutation}`);
    }
  });

  it("substitutes every supported placeholder and leaves none behind", () => {
    temporary(dir => {
      const template = path.join(dir, "template");
      fs.writeFileSync(template, placeholders.map(name => `@${name}@`).join("\n"));
      const result = bash('source "$1/unit-tools.sh"; render_unit "$2"', [linux, template]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, placeholders.map(name => settings[name as keyof typeof settings]).join("\n") + "\n");
      assert.doesNotMatch(result.stdout, /@/);
    });
  });

  it("uses documented placeholders, persistent restart and required hardening", () => {
    const readme = fs.readFileSync(path.join(linux, "README.md"), "utf8");
    for (const unit of units) {
      const template = fs.readFileSync(path.join(linux, `${unit}.service`), "utf8");
      assert.match(template, /^Restart=always$/m);
      assert.doesNotMatch(template, /Restart=on-failure|ProtectHome|DynamicUser/);
      for (const directive of ["RestartSec=30", "StartLimitIntervalSec=0", "NoNewPrivileges=yes",
        "PrivateTmp=yes", "ProtectSystem=full", "ProtectKernelTunables=yes",
        "ProtectControlGroups=yes", "RestrictSUIDSGID=yes", "UMask=0007",
        "StandardOutput=journal", "StandardError=journal"]) {
        assert.ok(template.split("\n").includes(directive), `${unit}: ${directive}`);
      }
      for (const match of template.matchAll(/@([^@\s]+)@/g)) {
        assert.ok(placeholders.includes(match[1]), match[0]);
        assert.ok(readme.includes(match[0]), `undocumented ${match[0]}`);
      }
      const rendered = render(unit);
      assert.doesNotMatch(rendered, /@[A-Z_]+@|\/Users\/|\/home\/(?!kleinbot(?:\/|\b))[a-z][a-z0-9_-]*/);
      assert.match(rendered, /^User=kleinbot$/m);
      assert.match(rendered, /^Group=kleinbot$/m);
      assert.match(rendered, /^ExecStart=\/usr\/local\/lib\/kleinbot\/run-daemon.sh /m);
      assert.ok(rendered.includes('PATH=/home/kleinbot/.local/bin:/usr/local/bin:/usr/bin:/bin'));
      assert.match(rendered, /^WorkingDirectory=\/srv\/kleinbot\/checkout$/m);
    }
    const signal = render("kleinbot-signal");
    assert.match(signal, /^After=.*kleinbot-signal-cli\.service$/m);
    assert.match(signal, /^Requires=kleinbot-signal-cli\.service$/m);
    assert.ok(signal.includes('ENTOURAGE_ALLOW_ROOTS=/srv/kleinbot/signal/attachments"'));
    const whatsapp = render("kleinbot-whatsapp");
    assert.doesNotMatch(whatsapp, /(?:After|Requires)=.*signal-cli/);
    assert.ok(whatsapp.includes('ENTOURAGE_ALLOW_ROOTS=/srv/kleinbot/whatsapp/attachments"'));
  });

  it("accepts rendered units and rejects secret assignments and changed execution identity", () => {
    temporary(dir => {
      const file = path.join(dir, "unit.service");
      const good = render("kleinbot-signal");
      const validate = () => bash('source "$1/unit-tools.sh"; validate_unit "$2" kleinbot-signal', [linux, file]);
      fs.writeFileSync(file, good);
      assert.equal(validate().status, 0);
      for (const name of ["EXAMPLE_TOKEN", "EXAMPLE_KEY", "PASSWORD", "DB_PASSWORD_HASH"]) {
        fs.writeFileSync(file, good.replace('[Service]', `[Service]\nEnvironment="SAFE=value" "${name}=dummy"`));
        assert.notEqual(validate().status, 0, name);
      }
      for (const bad of [good.replace("User=kleinbot", "User=root"),
        good.replace("ExecStart=", "ExecStart=+"),
        good.replace("[Service]", "[Service]\nExecStartPre=/bin/true"),
        good.replace("StandardOutput=journal", "StandardOutput=file:/etc/invalid"),
        good.replace("[Service]", "[Service]\nUser=kleinbot")]) {
        fs.writeFileSync(file, bad);
        assert.notEqual(validate().status, 0);
      }
      for (const directive of ["NoNewPrivileges=yes", "PrivateTmp=yes", "ProtectSystem=full", "Restart=always", "UMask=0007"]) {
        fs.writeFileSync(file, good.replace(`${directive}\n`, ""));
        assert.notEqual(validate().status, 0, `missing ${directive}`);
      }
    });
  });

  it("rejects unsafe substitutions and overlapping flags trees", () => {
    for (const env of [{ RUNTIME: "/srv/invalid%u" }, { CHECKOUT: "/srv/invalid\nUser=root" },
      { BOT_USER: "root" }, { FLAGS_SIGNAL: settings.FLAGS_WHATSAPP },
      { FLAGS_SIGNAL: `${settings.FLAGS_WHATSAPP}/nested` },
      { FLAGS_SIGNAL: `${settings.RUNTIME}/config` }, { RUNTIME: "/srv/../etc" },
      { FLAGS_SIGNAL: settings.WRAPPER_DIR }, { FLAGS_SIGNAL: "/etc/systemd" },
      { FLAGS_SIGNAL: "/srv/stage", HERE: "/srv/stage/installer" },
      { WRAPPER_DIR: `${settings.BOT_HOME}/wrapper` }, { BOT_HOME: "/srv/private/bot" }]) {
      const result = bash('source "$1/unit-tools.sh"; validate_settings', [linux], env);
      assert.notEqual(result.status, 0);
    }
    temporary(dir => {
      const file = path.join(dir, "unit.service");
      fs.writeFileSync(file, "User=@UNKNOWN@\n");
      assert.notEqual(bash('source "$1/unit-tools.sh"; render_unit "$2"', [linux, file]).status, 0);
    });
  });

  it("passes bash syntax checks for all Linux and macOS scripts", () => {
    for (const script of ["install.sh", "run-daemon.sh", "unit-tools.sh", "../macos/run-daemon.sh", "../macos/install.sh"]) {
      const result = spawnSync("bash", ["-n", path.join(linux, script)], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    }
  });

  it("passes systemd-analyze verify when available", t => {
    if (spawnSync("systemd-analyze", ["--version"]).error) {
      t.skip("systemd-analyze is unavailable on this platform");
      return;
    }
    temporary(dir => {
      fs.mkdirSync(path.join(dir, "bin"));
      fs.copyFileSync(path.join(linux, "run-daemon.sh"), path.join(dir, "bin/run-daemon.sh"));
      fs.chmodSync(path.join(dir, "bin/run-daemon.sh"), 0o755);
      for (const unit of units) {
        const rendered = bash('source "$1/unit-tools.sh"; render_unit "$1/$2.service"',
          [linux, unit], { WRAPPER_DIR: path.join(dir, "bin") });
        assert.equal(rendered.status, 0, rendered.stderr);
        fs.writeFileSync(path.join(dir, `${unit}.service`), rendered.stdout);
      }
      const result = spawnSync("systemd-analyze", ["verify", ...units.map(unit => path.join(dir, `${unit}.service`))],
        { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    });
  });
});

function prepareWrapper(dir: string) {
  for (const sub of ["config", "run", "checkout/node_modules/.bin", ".local/bin"]) fs.mkdirSync(path.join(dir, sub), { recursive: true });
  const probe = path.join(dir, "probe");
  fs.writeFileSync(probe, '#!/bin/bash\nprintf "%s\\n" "$@"\nprintf "cwd=%s\\n" "$PWD"\n/usr/bin/env\n', { mode: 0o755 });
  fs.copyFileSync(probe, path.join(dir, "checkout/node_modules/.bin/tsx"));
  fs.copyFileSync(probe, path.join(dir, ".local/bin/signal-cli"));
  return {
    HOME: dir, KLEINBOT_RUNTIME_DIR: dir, KLEINBOT_CHECKOUT: path.join(dir, "checkout"),
    PATH: "/usr/bin:/bin", SIGNAL_ACCOUNT: "dummy", SIGNAL_CLI_CONFIG_DIR: path.join(dir, "identity"),
  };
}

function runWrapper(daemon: string, env: NodeJS.ProcessEnv, platform = "linux") {
  return spawnSync("bash", [path.join(root, "scripts", platform, "run-daemon.sh"), daemon], {
    cwd: root, encoding: "utf8", env,
  });
}

describe("Linux daemon wrapper", () => {
  it("keeps the Linux and macOS parser and dispatcher in sync", () => {
    const shared = (platform: string) => fs.readFileSync(path.join(root, "scripts", platform, "run-daemon.sh"), "utf8")
      .split("# Keep this parser and command dispatcher identical on Linux and macOS.\n")[1];
    assert.ok(shared("linux"));
    assert.equal(shared("linux"), shared("macos"));
  });

  for (const platform of ["linux", "macos"]) {
    it(`${platform}: refuses injection and interpreter controls without executing values`, () => {
      temporary(dir => {
        const env = { ...prepareWrapper(dir), KLEINBOT_DRY_RUN: "1" };
        const marker = path.join(dir, "executed");
        for (const line of [
          `lineno=BASH_VERSINFO[$(touch ${marker})0]`, "IFS=", "lowercase=value", "_PREFIX=value",
          ...["PATH", "LD_PRELOAD", "LD_LIBRARY_PATH", "BASH_ENV", "ENV", "HOME", "SHELLOPTS", "PS4", "NODE_OPTIONS"]
            .map(key => `${key}=$(touch ${marker})`),
        ]) {
          fs.writeFileSync(path.join(dir, "config/daemon.env"), `# comment\n${line}\nNEXT=value\n`);
          const result = runWrapper("kleinbot-signal", env, platform);
          assert.equal(result.status, 78, `${line}: ${result.stderr}`);
          assert.match(result.stderr, /daemon.env line 2/);
          assert.doesNotMatch(result.stderr, /touch/);
          assert.equal(fs.existsSync(marker), false);
        }
        // No assignments are exported even when a later file is malformed.
        fs.writeFileSync(path.join(dir, "config/daemon.env"), `LITERAL=$(touch ${marker})\n`);
        fs.writeFileSync(path.join(dir, "config/.env"), "invalid=value\n");
        assert.equal(runWrapper("kleinbot-signal", env, platform).status, 78);
        assert.equal(fs.existsSync(marker), false);
      });
    });

    it(`${platform}: dry runs resolve literal CRLF values and commands without dependencies`, () => {
      temporary(dir => {
        const env = { ...prepareWrapper(dir), KLEINBOT_DRY_RUN: "1" };
        fs.rmSync(path.join(dir, "checkout/node_modules"), { recursive: true });
        const marker = path.join(dir, "executed");
        fs.writeFileSync(path.join(dir, "config/daemon.env"),
          `# CRLF\r\n\r\nORDER=first\r\nORDER=ignored\r\nQUOTED="Klein Bot"\r\nLITERAL='$(touch ${marker})'\r\nEMPTY=ignored\r\n`);
        fs.writeFileSync(path.join(dir, "config/.env"), "ORDER=second\r\nFALLBACK=last\r\nSIGNAL_ACCOUNT=fixture\r\nSIGNAL_CLI_CONFIG_DIR=/example/identity\r\n");
        for (const daemon of ["kleinbot-signal", "kleinbot-whatsapp", "signal-cli"]) {
          const { SIGNAL_ACCOUNT: _account, SIGNAL_CLI_CONFIG_DIR: _config, ...base } = env;
          const result = runWrapper(daemon, { ...base, EMPTY: "" }, platform);
          assert.equal(result.status, 0, result.stderr);
          assert.doesNotMatch(result.stdout, /\r/);
          for (const line of ["ORDER=first", "QUOTED=Klein Bot", `LITERAL=$(touch ${marker})`, "EMPTY=", "FALLBACK=last"]) {
            assert.ok(result.stdout.split("\n").includes(line), line);
          }
          if (daemon === "signal-cli") {
            assert.match(result.stdout, /^command: .*signal-cli --config \/example\/identity -a fixture daemon --socket /);
          } else {
            assert.ok(result.stdout.startsWith(`command: ${env.KLEINBOT_CHECKOUT}/node_modules/.bin/tsx src/index-${daemon.slice(9)}.ts\n`));
          }
          assert.equal(fs.existsSync(marker), false);
        }
        const result = runWrapper("kleinbot-signal", { ...env, KLEINBOT_DRY_RUN: "0" }, platform);
        assert.equal(result.status, 78);
        assert.match(result.stderr, /Missing executable .*node_modules\/\.bin\/tsx; run npm ci/);
      });
    });
  }

  it("preserves environment precedence, quoted literals, export syntax, and an unterminated last line", () => {
    temporary(dir => {
      const env = prepareWrapper(dir);
      const marker = path.join(dir, "executed");
      fs.writeFileSync(path.join(dir, "config/daemon.env"),
        `# comment\n\nPROCESS_INTERVAL=10\nEMPTY=replaced\nORDER=first\nexport QUOTED="Klein Bot"\nLITERAL='$(touch ${marker})'\nTICKS=\`touch ${marker}\``);
      fs.writeFileSync(path.join(dir, "config/.env"), "ORDER=second\nFALLBACK=last\n");
      const result = runWrapper("kleinbot-signal", { ...env, PROCESS_INTERVAL: "5000", EMPTY: "" });
      assert.equal(result.status, 0, result.stderr);
      for (const line of ["PROCESS_INTERVAL=5000", "EMPTY=", "ORDER=first", "QUOTED=Klein Bot", "FALLBACK=last",
        `LITERAL=$(touch ${marker})`, `TICKS=\`touch ${marker}\``, `cwd=${env.KLEINBOT_CHECKOUT}`]) {
        assert.ok(result.stdout.split("\n").includes(line), line);
      }
      assert.match(result.stdout, /^src\/index-signal.ts\n/);
      assert.equal(fs.existsSync(marker), false);
      const whatsapp = runWrapper("kleinbot-whatsapp", env);
      assert.equal(whatsapp.status, 0, whatsapp.stderr);
      assert.match(whatsapp.stdout, /^src\/index-whatsapp.ts\n/);
    });
  });

  it("fails on malformed env lines without disclosing their contents", () => {
    temporary(dir => {
      const env = prepareWrapper(dir);
      fs.writeFileSync(path.join(dir, "config/.env"), "# comment\nINVALID LINE\n");
      const result = runWrapper("kleinbot-signal", env);
      assert.equal(result.status, 78);
      assert.match(result.stderr, /line 2 is not KEY=VALUE/);
      assert.doesNotMatch(result.stderr, /INVALID LINE/);
    });
  });

  it("passes the Signal config directory before the subcommand and preserves non-socket paths", () => {
    temporary(dir => {
      const env = prepareWrapper(dir);
      const sock = path.join(dir, "run/signal.sock");
      fs.writeFileSync(sock, "keep");
      const result = runWrapper("signal-cli", { ...env, SIGNAL_CLI_BIN: path.join(dir, "probe") });
      assert.equal(result.status, 0, result.stderr);
      assert.ok(result.stdout.startsWith(`--config\n${env.SIGNAL_CLI_CONFIG_DIR}\n-a\ndummy\ndaemon\n--socket\n${sock}\n--receive-mode\non-connection\n`));
      assert.equal(fs.readFileSync(sock, "utf8"), "keep");
      fs.unlinkSync(sock);
      fs.symlinkSync(path.join(dir, "absent"), sock);
      assert.equal(runWrapper("signal-cli", env).status, 0);
      assert.equal(fs.lstatSync(sock).isSymbolicLink(), true);
      assert.notEqual(runWrapper("signal-cli", { ...env, SIGNAL_ACCOUNT: "" }).status, 0);
      assert.equal(runWrapper("unknown", env).status, 64);
    });
  });

  it("removes a stale Unix socket before launching signal-cli", async () => {
    // Keep this fixture short enough for sockaddr_un even in a long worktree.
    const dir = fs.mkdtempSync(path.join(root, ".s-"));
    const server = net.createServer();
    try {
      const env = prepareWrapper(dir);
      const socket = path.join(dir, "run/signal.sock");
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socket, resolve);
      });
      assert.equal(fs.lstatSync(socket).isSocket(), true);
      const result = runWrapper("signal-cli", env);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(fs.existsSync(socket), false);
    } finally {
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
