# Drawer Box Maker

A browser app for designing drawer divider boxes on a 50 mm grid. It exports print-ready **3MF** files for the **Bambu Lab H2S** (340 × 320 mm bed). Everything runs in the browser, so there's no server and nothing to install.

## Features
- **Drawer sizes:** Large (675 × 425), Small (400 × 425) or a custom size. The drawer fills with 50 mm boxes.
- **Leftover space:** if the drawer isn't an exact multiple of 50 mm, the outer boxes grow to fill the gap. You can switch this so all boxes grow evenly instead.
- **Merging:** click or drag to select boxes, then **Merge** (M) them into one bigger box. Rectangles, L-shapes and T-shapes all work. **Split** (S) undoes a merge.
- **Box sizes:** 3 mm base and 1 mm walls. Default height is 60 mm, and you can change the height of any box.
- **Label tabs:** each label tab sits on the inside of the front wall. Its underside is a 45° overhang, so it prints with **no supports**. Label text is raised on the tab and finishes flush with the rim.
- **Size warnings:** boxes that are too big for the H2S bed show in red.
- **Print plates:** boxes are packed automatically onto as many H2S plates as needed. You get one 3MF per plate, in a .zip if there's more than one.
- **Save and share:** layouts autosave in the browser. You can also save and open a .json file, or **Copy share link** to send a link that opens the exact layout.

## Put it on GitHub Pages
1. Create a new public repository on github.com, for example `drawer-box-maker`.
2. Click **Add file → Upload files**. Upload `index.html`, `app.js`, `geometry.js` and this `README.md`, then **Commit**.
3. Go to **Settings → Pages**. Under *Build and deployment*, choose **Deploy from a branch**, select `main` and `/ (root)`, then **Save**.
4. After about a minute the app is live at `https://<your-username>.github.io/drawer-box-maker/`. Share that link.

## Run it locally
ES modules don't load from `file://`, so serve the folder:

```
python3 -m http.server 8000
```

Then open http://localhost:8000.

## How it works
- `geometry.js`: grid maths, box solids built with [Manifold](https://github.com/elalish/manifold), label text from [opentype.js](https://opentype.js.org/), plate packing and 3MF writing.
- `app.js`: the user interface: layout editor, 3D preview with [three.js](https://threejs.org/), and export with [fflate](https://github.com/101arrowz/fflate).
- The libraries and the Roboto font load from the jsDelivr CDN.

## Printing tips
- Open a plate's 3MF in Bambu Studio and choose your filament. PLA works well.
- 1 mm walls print as two lines with a 0.4 mm nozzle. If the boxes feel too flexible, raise the wall thickness under **All boxes → Advanced**.
- The gap between boxes (default 0.5 mm) leaves room for the boxes to drop in. Raise it if they fit too tightly.
