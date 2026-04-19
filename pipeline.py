import argparse
import colorsys
import json
import re
import sys
from pathlib import Path

import numpy as np
from bertopic import BERTopic
from sentence_transformers import SentenceTransformer
from sklearn.feature_extraction.text import CountVectorizer
from sklearn.metrics.pairwise import cosine_similarity
from umap import UMAP


TALK_START = re.compile(r"^(\d{4}-\d{1,2}-\d{1,2})\s*\\?-\s+(.+)$")
SPEAKER_TITLE = re.compile(r"^([^:]+):\s+(.+)$")


def parse_talks(path: Path) -> list[dict]:
    text = path.read_text(encoding="utf-8")
    lines = text.splitlines()

    blocks: list[tuple[str, list[str]]] = []
    current_header = None
    current_body: list[str] = []

    for line in lines:
        m = TALK_START.match(line.strip())
        if m:
            if current_header is not None:
                blocks.append((current_header, current_body))
            current_header = line.strip()
            current_body = []
        else:
            if current_header is not None:
                stripped = line.strip()
                if stripped and stripped != ".":
                    current_body.append(stripped)

    if current_header is not None:
        blocks.append((current_header, current_body))

    talks = []
    for idx, (header, body_lines) in enumerate(blocks):
        m = TALK_START.match(header)
        date_str = m.group(1)
        rest = m.group(2).strip()

        sm = SPEAKER_TITLE.match(rest)
        if sm:
            speaker = sm.group(1).strip()
            title = sm.group(2).strip()
        else:
            speaker = ""
            title = rest

        abstract = " ".join(body_lines)

        slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:60]
        talk_id = f"{idx:03d}-{slug}"

        talks.append({
            "id": talk_id,
            "title": title,
            "abstract": abstract,
            "speaker": speaker,
            "date": date_str,
        })

    return talks


def embed(talks: list[dict], emb_path: Path) -> np.ndarray:
    print(f"[1/5] Embedding {len(talks)} talks with all-MiniLM-L6-v2 ...")
    model = SentenceTransformer("all-MiniLM-L6-v2")
    docs = [f"{t['title']}. {t['abstract']}" for t in talks]
    embeddings = model.encode(docs, show_progress_bar=True, convert_to_numpy=True)
    np.save(emb_path, embeddings)
    print(f"      Saved embeddings to {emb_path}  shape={embeddings.shape}")
    return embeddings


def cluster(talks: list[dict], embeddings: np.ndarray) -> tuple[list[int], list[str], list[str]]:
    print("[2/5] Clustering with BERTopic ...")
    topic_model = BERTopic(
        nr_topics="auto",
        min_topic_size=2,
        calculate_probabilities=True,
        vectorizer_model=CountVectorizer(stop_words="english"),
    )
    topic_ids, _ = topic_model.fit_transform(
        [f"{t['title']}. {t['abstract']}" for t in talks],
        embeddings,
    )

    topic_info = topic_model.get_topic_info()
    unique_topics = sorted(set(topic_ids))
    non_noise = [t for t in unique_topics if t != -1]

    hue_step = 1.0 / max(len(non_noise), 1)
    topic_colors: dict[int, str] = {-1: "#aaaaaa"}
    topic_labels: dict[int, str] = {}

    for rank, tid in enumerate(non_noise):
        h = rank * hue_step
        r, g, b = colorsys.hsv_to_rgb(h, 0.75, 0.85)
        topic_colors[tid] = "#{:02x}{:02x}{:02x}".format(
            int(r * 255), int(g * 255), int(b * 255)
        )

    for tid in unique_topics:
        words = topic_model.get_topic(tid)
        if words and tid != -1:
            label = ", ".join(w for w, _ in words[:4])
        else:
            label = "uncategorized"
        topic_labels[tid] = label

    print(f"      Found {len(non_noise)} topics (+noise bucket)")

    colors = [topic_colors[tid] for tid in topic_ids]
    labels = [topic_labels[tid] for tid in topic_ids]
    return list(topic_ids), labels, colors


def project_umap(embeddings: np.ndarray) -> np.ndarray:
    print("[3/5] Running UMAP projection ...")
    reducer = UMAP(n_components=2, metric="cosine", random_state=42)
    coords = reducer.fit_transform(embeddings)
    print(f"      Projection shape: {coords.shape}")
    return coords


def compute_edges(
    embeddings: np.ndarray,
    talks: list[dict],
    threshold: float,
    min_connections: int | None = None,
    max_connections: int | None = None,
) -> list[dict]:
    adaptive = min_connections is not None or max_connections is not None
    if adaptive:
        print(
            f"[4/5] Computing pairwise cosine similarity (threshold={threshold}, "
            f"min_connections={min_connections}, max_connections={max_connections}) ..."
        )
    else:
        print(f"[4/5] Computing pairwise cosine similarity (threshold={threshold}) ...")

    sim = cosine_similarity(embeddings)
    n = len(talks)

    if not adaptive:
        edges = []
        for i in range(n):
            for j in range(i + 1, n):
                w = float(sim[i, j])
                if w >= threshold:
                    edges.append({
                        "source": talks[i]["id"],
                        "target": talks[j]["id"],
                        "weight": round(w, 4),
                    })
        print(f"      Total edges: {len(edges)}")
        return edges

    # Adaptive thresholding: per-node edge selection, then union.
    # For each node, sort candidates by weight descending and select the range
    # that keeps the node within [min_connections, max_connections].
    accepted: set[tuple[int, int]] = set()

    for i in range(n):
        # Collect (weight, j) for all other nodes, sorted by weight descending.
        candidates = sorted(
            ((float(sim[i, j]), j) for j in range(n) if j != i),
            reverse=True,
        )

        # How many pass the global threshold?
        above = [(w, j) for w, j in candidates if w >= threshold]
        count = len(above)

        if min_connections is not None and count < min_connections:
            # Take the top min_connections regardless of global threshold.
            selected = candidates[:min_connections]
        elif max_connections is not None and count > max_connections:
            # Keep only the top max_connections.
            selected = above[:max_connections]
        else:
            selected = above

        for _, j in selected:
            edge = (min(i, j), max(i, j))
            accepted.add(edge)

    edges = [
        {
            "source": talks[i]["id"],
            "target": talks[j]["id"],
            "weight": round(float(sim[i, j]), 4),
        }
        for i, j in sorted(accepted)
    ]
    print(f"      Total edges: {len(edges)}")
    return edges


def export(
    talks: list[dict],
    topic_ids: list[int],
    topic_labels: list[str],
    colors: list[str],
    coords: np.ndarray,
    edges: list[dict],
    out_path: Path,
) -> None:
    print(f"[5/5] Writing {out_path} ...")
    nodes = []
    for i, talk in enumerate(talks):
        nodes.append({
            "id": talk["id"],
            "title": talk["title"],
            "abstract": talk["abstract"],
            "speaker": talk["speaker"],
            "date": talk["date"],
            "topic_id": topic_ids[i],
            "topic_label": topic_labels[i],
            "color": colors[i],
            "x": round(float(coords[i, 0]), 6),
            "y": round(float(coords[i, 1]), 6),
        })

    graph = {"nodes": nodes, "edges": edges}
    out_path.write_text(json.dumps(graph, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"      Wrote {len(nodes)} nodes and {len(edges)} edges.")


def main():
    parser = argparse.ArgumentParser(description="Talk discovery pipeline")
    parser.add_argument("--input", required=True, help="Path to talks markdown file")
    parser.add_argument("--output", required=True, help="Path for graph_data.json output")
    parser.add_argument("--threshold", type=float, default=0.75, help="Cosine similarity cutoff")
    parser.add_argument("--min-connections", type=int, default=None, help="Minimum edges per node (adaptive)")
    parser.add_argument("--max-connections", type=int, default=None, help="Maximum edges per node (adaptive)")
    args = parser.parse_args()

    input_path = Path(args.input)
    output_path = Path(args.output)
    emb_path = output_path.parent / "embeddings.npy"

    if not input_path.exists():
        print(f"Error: input file not found: {input_path}", file=sys.stderr)
        sys.exit(1)

    talks = parse_talks(input_path)
    print(f"Parsed {len(talks)} talks from {input_path}")

    embeddings = embed(talks, emb_path)
    topic_ids, topic_labels, colors = cluster(talks, embeddings)
    coords = project_umap(embeddings)
    edges = compute_edges(embeddings, talks, args.threshold, args.min_connections, args.max_connections)
    export(talks, topic_ids, topic_labels, colors, coords, edges, output_path)

    print("Done.")


if __name__ == "__main__":
    main()
