# Vehicle photos

Drop `.jpg` / `.jpeg` / `.png` vehicle photos here to use them for Images-tab
uploads on any machine. Anything in this folder is picked up automatically.

`images.js` rejects every other type with "Only JPG, JPEG, PNG allowed", and the
API rejects files over 10 MB.

To use folders outside the repo instead, set `DMS_PHOTOS_DIR` in `.env`
(comma separated for more than one):

```env
DMS_PHOTOS_DIR=D:\photos\jaguar,D:\photos\land-rover
```

If no folder has photos, the suite generates valid PNGs into
`test-results/fixtures/` so uploads still run.
