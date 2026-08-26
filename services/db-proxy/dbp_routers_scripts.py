# 路由:/scripts/*(我的目录 SQL 脚本树/文件读写)(APIRouter,路径不变)
# 装饰器由 @app.* 改为 @router.*(include_router 挂载,路径与行为零变化)

from __future__ import annotations
import json
import os
import uuid
from typing import Any, Dict, List, Optional
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel
from dbp_core import require_auth

router = APIRouter()


# ── 脚本存储(我的目录:保存 SQL 脚本)────────────────────────────
# 目录树元数据:scripts/tree.json;文件内容:scripts/files/<id>.sql
# 可用环境变量 DB_SCRIPTS_DIR 覆盖(docker 挂载建议挂此目录)
SCRIPTS_DIR = os.environ.get("DB_SCRIPTS_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), "scripts"))


TREE_FILE = os.path.join(SCRIPTS_DIR, "tree.json")


FILES_DIR = os.path.join(SCRIPTS_DIR, "files")


def _ensure_scripts() -> None:
    os.makedirs(FILES_DIR, exist_ok=True)
    if not os.path.exists(TREE_FILE):
        with open(TREE_FILE, "w", encoding="utf-8") as f:
            json.dump({"my": []}, f, ensure_ascii=False, indent=2)


def _load_tree() -> Dict[str, Any]:
    _ensure_scripts()
    try:
        with open(TREE_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {"my": []}


def _save_tree(tree: Dict[str, Any]) -> None:
    _ensure_scripts()
    with open(TREE_FILE, "w", encoding="utf-8") as f:
        json.dump(tree, f, ensure_ascii=False, indent=2)


def _find_node(nodes: List[Dict[str, Any]], nid: str):
    """在树中按 id 找节点(深度优先),返回 (节点, 父列表)。"""
    for i, n in enumerate(nodes):
        if n.get("id") == nid:
            return n, nodes
        if n.get("type") == "dir" and n.get("children"):
            found = _find_node(n["children"], nid)
            if found:
                return found
    return None


def _insert_node(parent: Optional[Dict[str, Any]], node: Dict[str, Any]) -> None:
    if parent is None:
        return
    parent.setdefault("children", []).append(node)


def _validate_name(name: str) -> str:
    name = (name or "").strip()
    if not name or "/" in name or "\\" in name or ".." in name:
        raise HTTPException(status_code=400, detail="非法名称")
    return name


@router.get("/scripts/tree")
def scripts_tree(x_db_token: Optional[str] = Header(default=None)) -> Dict[str, Any]:
    require_auth(x_db_token)
    return {"code": 0, "data": _load_tree()}


class ScriptNewReq(BaseModel):
    parentId: Optional[str] = None  # 空 = 根目录
    name: str
    kind: str  # "dir" | "file"


@router.post("/scripts/new")
def scripts_new(
    req: ScriptNewReq, x_db_token: Optional[str] = Header(default=None)
) -> Dict[str, Any]:
    require_auth(x_db_token)
    if req.kind not in ("dir", "file"):
        raise HTTPException(status_code=400, detail="kind must be dir|file")
    name = _validate_name(req.name)
    tree = _load_tree()
    my = tree["my"]
    parent = _find_node(my, req.parentId)[0] if req.parentId else None
    if req.parentId and (not parent or parent.get("type") != "dir"):
        raise HTTPException(status_code=404, detail="父目录不存在")
    node = {"id": uuid.uuid4().hex[:12], "name": name, "type": req.kind}
    if req.kind == "dir":
        node["children"] = []
    _insert_node(parent, node)
    _save_tree(tree)
    return {"code": 0, "data": node}


class ScriptRenameReq(BaseModel):
    id: str
    name: str


@router.post("/scripts/rename")
def scripts_rename(
    req: ScriptRenameReq, x_db_token: Optional[str] = Header(default=None)
) -> Dict[str, Any]:
    require_auth(x_db_token)
    name = _validate_name(req.name)
    tree = _load_tree()
    found = _find_node(tree["my"], req.id)
    if not found:
        raise HTTPException(status_code=404, detail="节点不存在")
    node = found[0]
    if node.get("type") == "file" and not name.endswith(".sql"):
        name += ".sql"
    node["name"] = name
    _save_tree(tree)
    return {"code": 0, "data": node}


class ScriptDeleteReq(BaseModel):
    id: str


def _collect_file_ids(nodes: List[Dict[str, Any]], out: List[str]) -> None:
    for n in nodes:
        if n.get("type") == "file":
            out.append(n["id"])
        elif n.get("type") == "dir" and n.get("children"):
            _collect_file_ids(n["children"], out)


@router.post("/scripts/delete")
def scripts_delete(
    req: ScriptDeleteReq, x_db_token: Optional[str] = Header(default=None)
) -> Dict[str, Any]:
    require_auth(x_db_token)
    tree = _load_tree()
    found = _find_node(tree["my"], req.id)
    if not found:
        raise HTTPException(status_code=404, detail="节点不存在")
    node, parent = found
    file_ids: List[str] = []
    _collect_file_ids([node], file_ids)
    parent.remove(node)
    for fid in file_ids:
        fp = os.path.join(FILES_DIR, f"{fid}.sql")
        if os.path.exists(fp):
            os.remove(fp)
    _save_tree(tree)
    return {"code": 0, "msg": "deleted"}


class ScriptSaveReq(BaseModel):
    id: str
    content: str


@router.post("/scripts/save")
def scripts_save(
    req: ScriptSaveReq, x_db_token: Optional[str] = Header(default=None)
) -> Dict[str, Any]:
    require_auth(x_db_token)
    tree = _load_tree()
    found = _find_node(tree["my"], req.id)
    if not found or found[0].get("type") != "file":
        raise HTTPException(status_code=404, detail="文件不存在")
    _ensure_scripts()
    with open(os.path.join(FILES_DIR, f"{req.id}.sql"), "w", encoding="utf-8") as f:
        f.write(req.content)
    return {"code": 0, "msg": "saved"}


@router.get("/scripts/get")
def scripts_get(
    id: str, x_db_token: Optional[str] = Header(default=None)
) -> Dict[str, Any]:
    require_auth(x_db_token)
    tree = _load_tree()
    found = _find_node(tree["my"], id)
    if not found or found[0].get("type") != "file":
        raise HTTPException(status_code=404, detail="文件不存在")
    fp = os.path.join(FILES_DIR, f"{id}.sql")
    content = ""
    if os.path.exists(fp):
        with open(fp, "r", encoding="utf-8") as f:
            content = f.read()
    return {"code": 0, "data": {"id": id, "content": content}}
