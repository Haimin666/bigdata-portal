#!/usr/bin/env python3
"""Generate db-proxy MySQL/Doris/Oracle entries from bi_hosts_databases.csv.

The CSV contains credential profiles, explicit datasource rows, and inventory
rows that expand to one datasource per database. JSON root settings and all
non-CSV datasource types from the existing config are preserved.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import stat
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Tuple
from urllib.parse import quote

PROJECT_ROOT = Path(__file__).resolve().parents[2]
MANAGED_TYPES = {"mysql", "oracle", "doris"}
DATABASE_NAMES_COLUMN = "数据库名称列表"
DATABASE_IDS_COLUMN = "数据库ID列表"
LEGACY_DATABASE_COLUMN = "数据库名称(ID)列表"
REQUIRED_COLUMNS = {
    "记录类型",
    "数据库类型",
    "主机",
    "端口",
    "Oracle服务名",
    "数据源名称列表",
    "凭据配置",
    "用户名",
    "密码",
    "标签",
    "字符集",
    "行数限制",
    "只读",
}


def _value(row: Dict[str, str], key: str) -> str:
    return (row.get(key) or "").strip()


def _read_csv(path: Path) -> Tuple[Dict[str, Dict[str, str]], List[Dict[str, str]]]:
    if not path.is_file():
        raise ValueError(f"CSV file not found: {path}")
    with path.open("r", encoding="utf-8-sig", newline="") as stream:
        reader = csv.DictReader(stream)
        columns = set(reader.fieldnames or [])
        missing = REQUIRED_COLUMNS - columns
        if missing:
            raise ValueError("CSV is missing required columns: " + ", ".join(sorted(missing)))
        has_database_names = DATABASE_NAMES_COLUMN in columns
        has_database_ids = DATABASE_IDS_COLUMN in columns
        if has_database_names != has_database_ids:
            raise ValueError(
                f"CSV must include both '{DATABASE_NAMES_COLUMN}' and '{DATABASE_IDS_COLUMN}'"
            )
        if not has_database_names and LEGACY_DATABASE_COLUMN not in columns:
            raise ValueError(
                "CSV must include separate database name/ID columns or the legacy "
                f"'{LEGACY_DATABASE_COLUMN}' column"
            )
        rows = list(reader)

    profiles: Dict[str, Dict[str, str]] = {}
    for row in rows:
        if _value(row, "记录类型") != "credential_profile":
            continue
        name = _value(row, "凭据配置")
        if not name:
            raise ValueError("credential_profile row has an empty profile name")
        if name in profiles:
            raise ValueError(f"duplicate credential profile: {name}")
        if not _value(row, "用户名") or not _value(row, "密码"):
            raise ValueError(f"credential profile '{name}' has an empty username or password")
        profiles[name] = row

    if "BI_DEFAULT" not in profiles:
        raise ValueError("CSV must contain the BI_DEFAULT credential_profile")
    return profiles, rows


def _port(value: str, source_name: str) -> int:
    try:
        port = int(value)
    except (TypeError, ValueError):
        raise ValueError(f"datasource '{source_name}' has an invalid port") from None
    if not 1 <= port <= 65535:
        raise ValueError(f"datasource '{source_name}' has an invalid port")
    return port


def _row_limit(value: str, source_name: str) -> Any:
    if not value:
        return None
    if value.isdecimal():
        return int(value)
    if value.casefold() == "rownum":
        return "rownum"
    raise ValueError(f"datasource '{source_name}' has an unsupported row limit")


def _bool_value(value: str, source_name: str) -> bool:
    if value.casefold() in {"true", "1", "yes"}:
        return True
    if value.casefold() in {"false", "0", "no", ""}:
        return False
    raise ValueError(f"datasource '{source_name}' has an invalid readOnly value")


def _make_connection_string(
    kind: str, host: str, port: int, database_or_service: str, profile: Dict[str, str], charset: str
) -> str:
    username = quote(_value(profile, "用户名"), safe="")
    password = quote(_value(profile, "密码"), safe="")
    url_host = f"[{host}]" if ":" in host and not host.startswith("[") else host
    path = quote(database_or_service, safe="")
    if kind == "oracle":
        return f"oracle://{username}:{password}@{url_host}:{port}/{path}"
    return f"mysql://{username}:{password}@{url_host}:{port}/{path}?charset={quote(charset, safe='')}"


def _database_entries(row: Dict[str, str], source_name: str) -> List[Tuple[str, str]]:
    """Return (database name, optional ID) entries from split or legacy CSV columns."""
    if DATABASE_NAMES_COLUMN in row:
        raw_names = _value(row, DATABASE_NAMES_COLUMN)
        names = [part.strip() for part in raw_names.split(";")] if raw_names else []
        if any(not name for name in names):
            raise ValueError(f"CSV row '{source_name}' has an empty item in {DATABASE_NAMES_COLUMN}")
        raw_ids = _value(row, DATABASE_IDS_COLUMN)
        ids = [part.strip() for part in raw_ids.split(";")] if raw_ids else []
        if ids and len(ids) != len(names):
            raise ValueError(
                f"CSV row '{source_name}' has {len(names)} database names but {len(ids)} database IDs"
            )
        if not ids:
            ids = [""] * len(names)
        return list(zip(names, ids))

    raw_legacy = _value(row, LEGACY_DATABASE_COLUMN)
    entries: List[Tuple[str, str]] = []
    for token in raw_legacy.split(";"):
        token = token.strip()
        if not token:
            continue
        match = re.fullmatch(r"(.+?)\((\d+)\)", token)
        entries.append((match.group(1).strip(), match.group(2)) if match else (token, ""))
    return entries


def _build_datasource(
    row: Dict[str, str],
    name: str,
    database_name: str,
    database_id: str,
    kind: str,
    profiles: Dict[str, Dict[str, str]],
    inventory: bool = False,
) -> Dict[str, Any]:
    if kind not in {"mysql", "doris", "oracle"}:
        raise ValueError(f"datasource '{name}' has unsupported type '{kind}'")
    host = _value(row, "主机")
    if not host:
        raise ValueError(f"datasource '{name}' has an empty host")
    port = _port(_value(row, "端口"), name)
    profile_name = _value(row, "凭据配置")
    profile = profiles.get(profile_name)
    if profile is None:
        raise ValueError(f"datasource '{name}' references unknown credential profile '{profile_name}'")
    profile_type = _value(profile, "数据库类型").casefold()
    if profile_type not in {"*", kind}:
        raise ValueError(f"credential profile '{profile_name}' does not match datasource '{name}' type")
    profile_sources = _value(profile, "数据源名称列表")
    if profile_sources != "*" and profile_sources != name:
        raise ValueError(f"credential profile '{profile_name}' is not scoped to datasource '{name}'")

    database_or_service = database_name
    if kind == "oracle":
        database_or_service = _value(row, "Oracle服务名")
        if inventory and not database_or_service:
            # Inventory rows list Oracle schemas. The maintained contract allows
            # the schema name to stand in for the service until an explicit one is supplied.
            database_or_service = database_name
    if not database_or_service:
        field = "Oracle service name" if kind == "oracle" else "database name"
        raise ValueError(f"datasource '{name}' has an empty {field}")

    charset = _value(row, "字符集") or "utf8mb4"
    runtime_type = "mysql" if kind == "doris" else kind
    datasource: Dict[str, Any] = {
        "name": name,
        "type": runtime_type,
        "connectionString": _make_connection_string(
            runtime_type, host, port, database_or_service, profile, charset
        ),
    }
    if database_id:
        datasource["databaseId"] = database_id
    if kind == "doris":
        datasource["sourceType"] = "doris"
    label = _value(row, "标签") or ("Doris" if kind == "doris" else "")
    if label:
        datasource["label"] = label
    row_limit = _row_limit(_value(row, "行数限制"), name)
    if row_limit is not None:
        datasource["rowLimit"] = row_limit
    readonly_raw = _value(row, "只读")
    if readonly_raw:
        datasource["readOnly"] = _bool_value(readonly_raw, name)
    return datasource


def build_config(csv_path: Path, config_path: Path) -> Tuple[Dict[str, Any], Dict[str, int]]:
    if not config_path.is_file():
        raise ValueError(f"base config not found: {config_path}")
    with config_path.open("r", encoding="utf-8") as stream:
        config = json.load(stream)
    if not isinstance(config, dict) or not isinstance(config.get("datasources"), list):
        raise ValueError("base config must contain a 'datasources' array")

    profiles, rows = _read_csv(csv_path)
    generated: List[Dict[str, Any]] = []
    names = set()
    explicit_names = set()
    inventory_sources: Dict[str, Tuple[str, str, str, str]] = {}
    generated_counts: Dict[str, int] = {"mysql": 0, "doris": 0, "oracle": 0}
    inventory_generated = 0
    inventory_duplicates_skipped = 0

    # Explicit rows carry intentional aliases/settings and take precedence over
    # inventory-generated entries with the same datasource name.
    for row in rows:
        if _value(row, "记录类型") != "datasource":
            continue
        name = _value(row, "数据源名称列表")
        kind = _value(row, "数据库类型").casefold()
        if not name:
            raise ValueError("datasource row has an empty data source name")
        if name in names:
            raise ValueError(f"duplicate datasource name in CSV: {name}")
        entries = _database_entries(row, name)
        if kind == "oracle" and not entries:
            # Explicit Oracle rows connect to a service, not a schema name.
            database_name, database_id = "", ""
        elif len(entries) == 1 and entries[0][0]:
            database_name, database_id = entries[0]
        else:
            raise ValueError(f"datasource '{name}' must contain exactly one database name")
        datasource = _build_datasource(
            row, name, database_name, database_id, kind, profiles
        )
        generated.append(datasource)
        names.add(name)
        explicit_names.add(name)
        generated_counts[kind] += 1

    for row in rows:
        if _value(row, "记录类型") != "inventory":
            continue
        row_label = _value(row, "标签") or _value(row, "主机") or "inventory row"
        kind = _value(row, "数据库类型").casefold()
        entries = _database_entries(row, row_label)
        if not entries:
            raise ValueError(f"inventory row '{row_label}' has no database names")
        host = _value(row, "主机")
        port_text = _value(row, "端口")
        profile_name = _value(row, "凭据配置")

        for database_name, database_id in entries:
            if not database_name:
                raise ValueError(f"inventory row '{row_label}' has an empty database name")
            name = database_name
            target = (kind, host, port_text, database_name)
            if name in explicit_names:
                inventory_duplicates_skipped += 1
                continue
            if name in inventory_sources:
                if inventory_sources[name] != target:
                    raise ValueError(
                        f"inventory datasource name '{name}' maps to multiple database targets"
                    )
                inventory_duplicates_skipped += 1
                continue

            datasource = _build_datasource(
                row, name, database_name, database_id, kind, profiles, inventory=True
            )
            generated.append(datasource)
            names.add(name)
            inventory_sources[name] = target
            generated_counts[kind] += 1
            inventory_generated += 1

    if not generated:
        raise ValueError("CSV contains no datasource or inventory database rows")

    preserved: List[Dict[str, Any]] = []
    for source in config["datasources"]:
        if not isinstance(source, dict):
            raise ValueError("base config contains a non-object datasource")
        kind = str(source.get("type", "")).casefold()
        if kind not in MANAGED_TYPES:
            preserved.append(source)

    preserved_names = {
        str(source.get("name", "")) for source in preserved if source.get("name")
    }
    conflicts = preserved_names & names
    if conflicts:
        raise ValueError(
            "CSV datasource names conflict with preserved non-CSV datasource names: "
            + ", ".join(sorted(conflicts))
        )

    config["datasources"] = preserved + generated
    summary = {
        "generated_mysql": generated_counts["mysql"],
        "generated_doris": generated_counts["doris"],
        "generated_oracle": generated_counts["oracle"],
        "generated_from_inventory": inventory_generated,
        "inventory_duplicates_skipped": inventory_duplicates_skipped,
        "preserved_non_csv_datasources": len(preserved),
        "root_settings_preserved": len(config) - 1,
    }
    return config, summary


def _write_private_json(output_path: Path, config: Dict[str, Any]) -> None:
    parent = output_path.parent.resolve()
    if not parent.is_dir():
        raise ValueError(f"output directory not found: {parent}")
    fd, temporary_name = tempfile.mkstemp(
        prefix=f".{output_path.name}.", suffix=".tmp", dir=str(parent)
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(config, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
        os.chmod(temporary, stat.S_IRUSR | stat.S_IWUSR)
        os.replace(temporary, output_path)
        os.chmod(output_path, stat.S_IRUSR | stat.S_IWUSR)
    except Exception:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass
        raise


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Generate db-proxy MySQL/Doris/Oracle datasource entries from the maintained CSV."
    )
    parser.add_argument(
        "--csv", type=Path, default=PROJECT_ROOT / "bi_hosts_databases.csv",
        help="maintained datasource CSV (default: project-root bi_hosts_databases.csv)",
    )
    parser.add_argument(
        "--config", type=Path, required=True,
        help="existing datasources.json used as the base; root and non-CSV engines are preserved",
    )
    parser.add_argument(
        "--output", type=Path,
        help="output JSON path (default: overwrite --config atomically)",
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="validate CSV/config and print counts without writing files",
    )
    args = parser.parse_args()
    config_path = args.config.expanduser().resolve()
    output_path = (args.output or args.config).expanduser().resolve()
    csv_path = args.csv.expanduser().resolve()
    try:
        config, summary = build_config(csv_path, config_path)
        if args.dry_run:
            print(json.dumps(summary, ensure_ascii=False, indent=2))
            return 0
        _write_private_json(output_path, config)
        print(json.dumps({**summary, "output": str(output_path), "mode": "600"}, ensure_ascii=False, indent=2))
        return 0
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        parser.error(str(exc))
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
