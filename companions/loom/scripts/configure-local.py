import argparse
import json
import os
from pathlib import Path
import secrets
import shutil
import tomllib


def toml_scalar(value):
    if isinstance(value, bool):
        return str(value).lower()
    if isinstance(value, (str, int, float)):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, list):
        return '[' + ', '.join(toml_scalar(item) for item in value) + ']'
    raise ValueError('Unsupported runtime setting type.')


def toml_document(values, prefix=()):
    rows = []
    for key, value in values.items():
        if not isinstance(value, dict):
            rows.append(json.dumps(key) + ' = ' + toml_scalar(value))
    for key, value in values.items():
        if isinstance(value, dict):
            path = prefix + (key,)
            rows.append('\n[' + '.'.join(json.dumps(part) for part in path) + ']')
            rows.append(toml_document(value, path))
    return '\n'.join(rows) + '\n'


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    if os.name != 'nt':
        path.chmod(0o600)


def main():
    parser = argparse.ArgumentParser()
    for name in ['private-dir', 'workspace', 'codex-home', 'codex-entry', 'node', 'temp-dir', 'npm-cache']:
        parser.add_argument('--' + name, required=True)
    args = parser.parse_args()
    private = Path(args.private_dir).resolve()
    if not private.is_dir():
        raise SystemExit('Create and restrict the private configuration directory first.')
    if (private / 'runner.json').exists():
        raise SystemExit('Runner configuration already exists; it was not replaced.')
    setup = json.loads((private / 'setup.json').read_text(encoding='utf-8-sig'))
    access_path = private / 'access.json'
    if not access_path.exists():
        write_json(access_path, {key: secrets.token_urlsafe(32) for key in ['ownerKey', 'runnerKey', 'askKey']})
    access = json.loads(access_path.read_text(encoding='utf-8'))
    original_home = Path(args.codex_home).resolve()
    source = tomllib.loads((original_home / 'config.toml').read_text(encoding='utf-8-sig'))
    local_home = private / 'codex-home'
    local_home.mkdir(mode=0o700)
    keep = ['model', 'model_provider', 'model_reasoning_effort', 'model_verbosity', 'service_tier',
            'preferred_auth_method', 'forced_login_method', 'cli_auth_credentials_store', 'chatgpt_base_url']
    runtime = {key: source[key] for key in keep if key in source}
    provider_name = source.get('model_provider', 'openai')
    provider = source.get('model_providers', {}).get(provider_name)
    if provider:
        runtime['model_providers'] = {provider_name: provider}
    runtime['approval_policy'] = 'on-request'
    runtime['sandbox_mode'] = 'workspace-write'
    runtime['windows'] = {'sandbox': 'unelevated'}
    runtime['features'] = {'multi_agent': False}
    (local_home / 'config.toml').write_text(toml_document(runtime), encoding='utf-8')
    auth = original_home / 'auth.json'
    if auth.is_file():
        shutil.copyfile(auth, local_home / 'auth.json')
    temporary = Path(args.temp_dir).resolve()
    profile = temporary / 'profile'
    for path in [temporary, profile, profile / 'AppData' / 'Local', profile / 'AppData' / 'Roaming', Path(args.npm_cache)]:
        path.mkdir(parents=True, exist_ok=True)
    workspace = Path(args.workspace).resolve()
    workspace.mkdir(parents=True, exist_ok=True)
    env = {
        'CODEX_HOME': str(local_home), 'HOME': str(profile), 'USERPROFILE': str(profile),
        'APPDATA': str(profile / 'AppData' / 'Roaming'), 'LOCALAPPDATA': str(profile / 'AppData' / 'Local'),
        'TEMP': str(temporary), 'TMP': str(temporary), 'npm_config_cache': str(Path(args.npm_cache).resolve()),
        'PYTHONDONTWRITEBYTECODE': '1',
    }
    required_env = [provider.get('env_key')] if provider else []
    if provider:
        required_env.extend((provider.get('env_http_headers') or {}).values())
    for name in required_env:
        if name:
            value = os.environ.get(name)
            if not value:
                raise SystemExit('The selected provider needs an environment credential that is not present in this process.')
            env[name] = value
    write_json(private / 'runner.json', {
        'serverUrl': setup['publicUrl'], 'runnerKey': access['runnerKey'], 'stateDir': str(private / 'runner-state'),
        'label': 'Windows workstation', 'command': str(Path(args.node).resolve()),
        'args': [str(Path(args.codex_entry).resolve())], 'env': env,
        'workspaces': [{'id': 'workspace', 'label': 'Dedicated workspace', 'path': str(workspace)}],
    })
    print('Local configuration prepared. Provider configuration and credentials remain in the private local directory.')
    print('No credential values were printed.')


if __name__ == '__main__':
    main()
