# training_progresses

Live training progress, served at <https://turabiyldrm.com/training_progresses/>.

- `index.html`: static page; it reads `data/manifest.json` and renders every data file listed there.
- `data/manifest.json`: `{"sources": [{"id", "label", "file"}]}`, one entry per machine.
- `data/<id>.json`: one file per machine, written only by that machine's publisher.

The files are generated automatically by a publisher script on each training machine. Each publisher:

- owns its own data file and its own manifest entry;
- rebases onto `origin/main` before every push and never force-pushes.

Other contributors should leave this folder to the publishers. To add a machine, give it its own `data/<id>.json`
and add an entry to `manifest.json` without removing the others.
