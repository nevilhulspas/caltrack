# Claude Code Instructions

## Commit Workflow

Commit each change immediately after making it. Don't batch multiple changes into a single commit.

```bash
git add <files> && git commit -m "message" && git push origin master
```

## Commit Message Format

```
<type>: <short description>

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `chore`

## Supabase Deployments

Use Supabase MCP tools to deploy Edge Functions:
- `mcp__plugin_supabase_supabase__deploy_edge_function`
- Project ID: `ymstbwfufjysoanzfnjm`
