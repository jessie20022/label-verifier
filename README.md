# Label Verifier

A standalone prototype that checks whether what is printed on an alcohol label matches the
application submitted for it. An agent gives it the application details and a **picture of the
label**; it reads the picture, compares every field, and reports what matches and what does not.
A whole spreadsheet of applications and their pictures can be checked in one go.

**Live app:** `https://jessie20022.github.io/label-verifier/`

## How it works

```
 picture of label ──► clean up ──► OCR (reads the text) ──► sort text into fields ──► compare with application ──► result
   (PNG / JPG)      grey, even      Tesseract, a neural        brand, class, ABV,        exact / needs review /       Pass
                    lighting,       network that runs in       net contents, origin,     fail, per field              Needs review
                    straighten      your browser               government warning                                     Fail
```

1. **Clean up the picture** (`src/ocr/preprocess.ts`): scaled to a readable size, turned to grey, lighting evened out (shadows, a dark table around the label), contrast stretched.
2. **Read the text with OCR** (`src/ocr/engine.ts`): [Tesseract.js](https://github.com/naptha/tesseract.js), an open-source OCR engine whose recognizer is a neural network (an LSTM). This is the "AI" part. It returns every line of text with its position and size. It runs **inside the browser** through WebAssembly, and its files are served from this site (`vite.config.ts` serves them straight from `node_modules` while developing and adds them to the published build), so no picture ever leaves the computer and nothing is fetched from another website. That matters on a network that blocks outside domains.
3. **Fix the orientation** (`src/ocr/readLabel.ts`, `deskew.ts`): if the first reading is poor, the picture is turned 90/180/270 degrees and read again (labels photographed sideways or upside down). A slight tilt is measured from the text lines and straightened, then the picture is read again.
4. **Work out which text is which field** (`src/ocr/extractFields.ts`): OCR lines are evaluated using their text, confidence, and position. The reader identifies brand, class/type, alcohol content, proof, net contents, country of origin, and government warning. Application brand and class values can guide the search, but they are not automatically substituted for text that could not be read. The extracted label text is what gets compared with the application.
5. **Compare with the application** (`src/rules/`): plain, testable rules, listed below.
6. **Estimate whether the warning header is bold** (`src/ocr/boldCheck.ts`): compares the thickness of the letter strokes in `GOVERNMENT WARNING:` with the sentence after it. This is an estimate, see limitations.

If a label arrives as text instead of a picture (a `.txt` file, pasted text, or text columns in the CSV),
steps 1-4 are skipped and the same rules run on that text.

## What it checks

| Check               | Rule                                                                                                                                                                                                                                                                                                                                                        |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Brand name          | Exact match passes. Differences in capitalization or punctuation only are Needs review. A picture reading that is very close (about 85% or more similar) is also Needs review because it may be an OCR misread. Brand extraction must first identify a usable label-text candidate; the application hint is not automatically treated as the label reading. |
| Class/type          | Same logic as brand name.                                                                                                                                                                                                                                                                                                                                   |
| Alcohol content     | Label percentage must equal the application. If proof is printed it must equal 2 x the percentage.                                                                                                                                                                                                                                                          |
| Net contents        | Compared as a volume, so `750 mL`, `750ml`, `75 cl` and `0.75 L` all match.                                                                                                                                                                                                                                                                                 |
| Country of origin   | Only enforced for imports (when the application lists a country). Missing on the label fails. `Product of Scotland` is accepted for `Scotland`.                                                                                                                                                                                                             |
| Government warning  | Word-for-word the standard text, and `GOVERNMENT WARNING:` must be all capitals (title case fails). Line breaks and extra spaces are ignored. For pictures, up to three words that are each only one or two characters off are **Needs review** (probably a misread); a different, added or missing word fails.                                             |
| Warning header bold | Pictures only. If the header does not look bolder than the text after it: **Needs review**.                                                                                                                                                                                                                                                                 |

Each label gets an overall status equal to its worst check: **Pass**, **Needs review** or **Fail**.

## Run it locally

You need [Node.js](https://nodejs.org) 20 or newer.

```bash
npm install        # installs everything, including the OCR engine
npm run dev        # starts the app
```

Open **http://localhost:5173/label-verifier/** (the `/label-verifier/` part matters; see "Deploying"). The first label you check takes a few seconds longer while the reader starts; after that it is fast.

**If a label will not check:** the app always shows a message in a red box saying why. The most common cause is that the reader's files could not be found, which means `npm install` has not been run in this folder (or an old copy of `npm run dev` is still running from before the update). Stop the app (Ctrl+C), run `npm install`, and start it again with `npm run dev`. Then reload the page.

```bash
npm test -- --run  # run the unit tests once
npm run build      # type-check and build the production site into dist/
npm run preview    # serve the production build at http://localhost:4173/label-verifier/
```

## Try it Using the App

Once the app is running, you can check an individual bottle label or test multiple labels at once.

### Checking an Individual Label

Open _Check one label_, pick an entry from **Try a sample**, and click **Check this label**.

To test your own picture, type the application details, choose your image, and check:

1. Enter the product information from the application, including the brand, class/type, alcohol content (ABV), and net contents.
2. Upload a picture of the bottle label. Use a clear, well-lit image where the printed text is visible.
3. Start the check and allow the app to process the image.
4. Review the results. The app uses OCR to read the label and compares the extracted information against the application details.
5. Check any fields marked as mismatched, missing, or needing review. You can also review the recognized label text to see what the OCR system read.

The app checks the brand, class/type, ABV, net contents, country of origin (when applicable), and government warning. It also evaluates the government warning's formatting, including whether the heading appears in bold.

### Bulk Testing

Bulk Testing lets you check multiple bottle labels in one run using a spreadsheet and a set of label images.

Open _Check many labels_ and click **Load the 10 sample labels**, then **Check 10 labels**.

To use your own, select the spreadsheet **and all the pictures together** in the file window.

1. Prepare a CSV spreadsheet with one row per product. Include these required application columns:
   | Column | Required | Meaning |
   | --------------------------------------------------------------------------------------- | --------------------------------------- | --------------------------------------------------- |
   | `app_brand`, `app_class`, `app_abv`, `app_net` | yes | What the application says |
   | `image_file` | yes, for pictures | File name of the label picture, e.g. `label-01.png` |
   | `app_origin` | no | Country, for imports |
   | `id` | no | Your own reference number |
   | `label_brand`, `label_class`, `label_abv`, `label_net`, `label_warning`, `label_origin` | only if there is no `image_file` column | Label text typed in, instead of a picture |

Names are not case-sensitive.

2. Add an `image_file` column containing the filename of the label image for each row. For example, if a row uses `label-01.png`, enter `label-01.png` in that row's `image_file` cell. You can also include `app_origin` and an `id` column.

3. Select the CSV file and all of the corresponding label images together when choosing files to upload. Make sure the filenames in the spreadsheet match the image filenames exactly.

4. Run the bulk test. The app matches each image to its spreadsheet row, reads the label, and compares the extracted information with the application details.

5. Review the results for each product. The output includes the application values, the values read from the label, and any warnings or discrepancies that need attention. **Export results as CSV** saves the outcome.

**Important:** For image-based bulk testing, include the `image_file` column and upload the matching pictures along with the spreadsheet. If you provide label text directly in columns such as `label_brand`, `label_class`, `label_abv`, `label_net`, `label_warning`, and `label_origin` instead, the app treats those columns as supplied label text rather than running OCR on pictures. This is useful for testing the comparison logic without image processing.

### Sample data (`public/samples/`)

| File                                        | What it tests                                                    | Expected result |
| ------------------------------------------- | ---------------------------------------------------------------- | --------------- |
| `images/label-01-pass.png`                  | Everything correct                                               | Pass            |
| `images/label-02-case-difference.png`       | `STONE'S THROW` on the label, `Stone's Throw` on the application | Needs review    |
| `images/label-03-titlecase-warning.png`     | Header printed as `Government Warning:`                          | Fail            |
| `images/label-04-wrong-abv.png`             | Label 46%, application 43%                                       | Fail            |
| `images/label-05-altered-warning.png`       | Warning says "may impair" instead of "impairs"                   | Fail            |
| `images/label-06-import-ok.png`             | Import; `75 cl` vs `750 mL`; `Product of Scotland`               | Pass            |
| `images/label-07-missing-warning.png`       | No government warning at all                                     | Fail            |
| `images/label-08-glare-skew.jpg`            | Photo on a table: tilted, glare, blur                            | Pass            |
| `images/label-09-rotated-sideways.png`      | Picture turned on its side                                       | Pass            |
| `images/label-10-header-not-bold.png`       | Warning header in regular weight                                 | Needs review    |
| `sample-batch-images.csv`                   | The 10 applications above, for batch mode                        |                 |
| `sample-batch-images.zip`                   | The CSV plus all 10 pictures in one download                     |                 |
| `sample-batch-text.csv`, `sample-label.txt` | Text-only inputs (no pictures)                                   |                 |

The images are drawn by `tools/make_samples.py` (`pip install pillow numpy`, then `python3 tools/make_samples.py`)
and are original test data.

## Performance

OCR time depends on image quality, orientation, label complexity, and how many recovery readings are needed. Clean, upright labels generally require fewer OCR passes than tilted or difficult images. Batch processing runs multiple readers in parallel, so total processing time depends on the computer's available resources.

Performance figures should be treated as version-specific and re-tested after changes to the OCR pipeline.

## Project layout

```
src/
  ocr/          preprocess.ts  engine.ts  readLabel.ts  deskew.ts  extractFields.ts  boldCheck.ts  errors.ts  (+ tests)
  rules/        normalize.ts  checks.ts  wordDiff.ts  verify.ts  types.ts  (+ tests)
  parsing/      parseCsv.ts  parseLabelText.ts  exportCsv.ts  (+ tests)
  components/   SingleCheck  BatchUpload  ResultsTable  ReadDetails  CheckList  FileDrop  StatusBadge
  samples.ts    the built-in sample catalogue
  App.tsx       two-tab shell
public/samples/ sample pictures, CSVs and text
tools/          make_samples.py
vite.config.ts  build settings, plus the small plugin that serves/bundles the OCR engine files
.github/workflows/deploy.yml   test, build and publish to GitHub Pages on every push to main
```

## Tools and choices

- **React + TypeScript + Vite**: typed, fast, builds to plain static files for GitHub Pages.
- **Tesseract.js**: uses an LSTM-based recognition engine and is an OCR in the browser. Chosen because the agency blocks outbound traffic to cloud AI services and a past vendor pilot failed on exactly that, and because a cloud call per label would be slow. The cost is that it is a general text reader rather than a model that understands labels, which is why field extraction and tolerance for misreads are handled in our own code. This OCR handles texts in straight lines, and struggles to work with curved text.
- **PapaParse** for CSV, **Vitest** for tests, plain CSS with large type and buttons, and status shown as symbol + words + colour so it never depends on colour alone.
- **Rules are ordinary code, not AI.** The comparison is deterministic and explainable: every result says exactly why. The **Needs review** status reflects the stakeholder point that some differences are obviously harmless and need human judgment, not automatic rejection.

## Assumptions

- Standalone proof of concept; no COLA integration. Nothing is uploaded, stored or logged. Pictures are read
  in the browser and discarded when the page is closed.
- Focus is distilled spirits (the sample label), with the standard federal warning text.
- Class/type is compared to the application as free text; there is no list of valid TTB class designations.
- Net contents are equal if within 1.5 mL.
- Given this application is verfication-style, field readings will be based on the user-inputted values
- Images will be straight-lined due to limitation of the Tesseract.js OCR tool

## Limitations and next steps

- **Reading quality depends on the picture.** Works well on clear, reasonably straight, well-lit labels. It
  struggles with very small print, a strong tilt (beyond roughly 10 to 15 degrees), curved bottles, heavy
  glare over text, decorative or script fonts, and low resolution. When it cannot read the warning it says
  the warning is missing or different (a failure), never a silent pass, and the _What we read_ panel shows
  the text it saw so an agent can judge for themselves.
- **Bold detection is an estimate.** It measures stroke thickness, works best when the header is in capitals
  at a similar size to the text after it, and can be fooled by blur or unusual fonts. It only ever asks for
  review, never fails a label by itself.
- **Brand and class are found by heuristics** (largest print, class keywords) plus the application hint. An
  unusual layout can confuse them; the review panel shows what was picked.
- **Not implemented:** beer and wine rules (ABV exceptions, sulfite statements), checking the bottler's name
  and address, and understanding that `UK` and `United Kingdom` are the same country.
- **A stronger reader** (a cloud or on-premises vision model) could handle bad photos, curved labels, and
  true bold detection better. It would need network approval from IT and a security review, which is why
  it was left out of the prototype.
- A real deployment would need the security, retention and PII review described by IT, and COLA integration.
