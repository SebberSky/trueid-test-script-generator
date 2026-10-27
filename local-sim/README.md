# Flowforge local Simulator MCP

Cloud Flowforge MCP (`/api/mcp`) cannot see your Mac iOS Simulator.  
Simulator a11y scan and path explore run as a **second** Cursor MCP: `flowforge-local-sim`.

## What you get

| Tool | Purpose |
|---|---|
| `scan_accessibility_ids` | Dump accessibility ids on the current sim screen |
| `explore_sim_paths` | Walk root tabs, optional scroll + re-tap |
| `generate_helpers_from_a11y` | Create only missing share helpers |
| `generate_test_script` | Gen from GWT; share first; scan only on gaps |
| `enrich_flowforge_script` | Fill Flowforge TODO/WARNING drafts |
| `setup_environment` / `list_simulators` / `launch_trueid` | Local setup helpers |

## Install in Cursor

1. Have a checkout of `trueid-ios-v3` (or a worktree) that includes `trueid-v3-uitest/scripts/flowforge_local_mcp.mjs`.
2. Boot a Simulator with TrueID Preprod; install `mobilecli` agent if needed (`setup_environment`).
3. Add this to `~/.cursor/mcp.json` (replace the path):

```json
{
  "mcpServers": {
    "flowforge-mobilewright": {
      "url": "https://flowforge-mobilewright.chawapon-rr.chatgpt.site/api/mcp"
    },
    "flowforge-local-sim": {
      "command": "/opt/homebrew/bin/node",
      "args": [
        "/ABSOLUTE/PATH/trueid-ios-v3/trueid-v3-uitest/scripts/flowforge_local_mcp.mjs"
      ],
      "env": {
        "FLOWFORGE_LOCAL_MCP_VERSION": "0.3.2",
        "PATH": "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
      }
    }
  }
}
```

4. Cursor → Settings → MCP → restart `flowforge-local-sim` until status is **ready**.
5. Ask the agent to call `scan_accessibility_ids` (standalone — does not require generate).

## Discover from cloud MCP

Anyone already connected to cloud Flowforge can call:

1. `get_sim_scan_setup` — mcp.json snippet + prerequisites  
2. `prepare_local_gen` — after `parse_gwt`, returns **exact** local tool + arguments

### Agent pipeline

```
cloud: load_jira_ticket → parse_gwt → prepare_local_gen
local:  call nextLocalCall.tool with nextLocalCall.arguments
        → trueid-v3-uitest/tests/generated_mcp/<ticket>.spec.ts
```

If `prepare_local_gen` chooses `enrich_flowforge_script`, pass the cloud draft as `flowforgeScript`.  
Local gen is share-first (`explore: auto`); it scans only when stuck.

## Why two MCPs

- **Cloud**: Jira OAuth, ticket load, GWT parse, draft script — runs on the Site worker.
- **Local**: `mobilecli` dump/tap/swipe on your Simulator — must run on the engineer’s Mac.
