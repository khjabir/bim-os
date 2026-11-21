# Contributing to bim-os

Thank you for helping. bim-os is a young project and every kind of contribution counts: bug reports, model files that break something, fixes, features, documentation and testing on other browsers and platforms.

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to help

- **Report a bug.** Open an issue with what you did, what you expected and what happened instead. Say which page (`/ifc`, `/rvt`, `/nwd`, `/convert`), your browser and operating system, and the size and type of the file. Errors from the browser console help a lot.
- **Share a file that breaks.** If a model does not open, converts wrongly or fills the asset register badly, a sample is the fastest way to a fix. Only attach files you are allowed to share, and remove anything confidential first. A small extract that shows the problem is better than a whole project.
- **Suggest a feature.** Open an issue that describes the problem you want solved and how you work today. For larger changes, agree on the approach in the issue before writing much code.
- **Improve the documentation.** The pages in [docs/](docs/) explain how each part works; corrections and clearer explanations are welcome.

Security problems are the exception: report them privately as described in [SECURITY.md](SECURITY.md), not in a public issue.

## Setting up

You need [Node.js](https://nodejs.org) 20.9 or newer and npm.

```bash
git clone https://github.com/<your-account>/bim-os.git
cd bim-os
npm install
npm run dev
```

The app runs at <http://localhost:3000>. `npm install` also copies the web-ifc, Fragments and pdf.js workers into `public/`, so the app serves them itself.

Keys are optional. To work on the AI assistant or the Autodesk routes, copy `.env.example` to `.env.local` and fill in your own keys (see [Configuration](README.md#configuration)). Never commit `.env.local` or any key.

[Development notes](docs/development.md) describes the project layout, the dependency versions that are pinned on purpose and why, and how to rebuild the in-browser Revit reader.

## Making a change

1. Fork the repository and create a branch from `main` with a short descriptive name (`fix/ifczip-zip64-offset`, `feat/ids-material-facets`).
2. Keep each pull request to one change. Small pull requests are reviewed sooner.
3. Follow the style of the code around you:
   - TypeScript in strict mode; no `any` where a type can be written.
   - React function components and Tailwind classes for the interface.
   - Heavy work (parsing, converting, writing files) in web workers, so the page stays responsive with large models.
   - No scripts or assets fetched from CDNs at run time; the app serves what it needs from `public/`.
   - Comments that say why, not what.
4. Check your change:

   ```bash
   npm run typecheck
   npm run build
   ```

   Then try it in the browser, ideally with more than one model, including a large one if your change touches loading, converting or memory use.
5. Update the documentation when behaviour changes: the README for anything a newcomer needs, the relevant page in `docs/` for details, and [docs/testing.md](docs/testing.md) for what you tested.
6. Open a pull request. Describe what changed and why, how you tested it, and link the issue it addresses. Add screenshots for interface changes.

### Tests

The repository does not have an automated test suite yet; until now changes have been checked by hand and with scripts kept outside the repository (see [docs/testing.md](docs/testing.md)). Until a suite exists, explain in your pull request how you verified the change, and include the files or steps needed to repeat it. Contributions that add automated tests, for example known-answer tests for the IFC writer or the asset register, are especially welcome.

### Dependencies

Add a dependency only when it clearly earns its place, and say why in the pull request. Its licence must be compatible with MIT (MIT, ISC, BSD, Apache-2.0 and MPL-2.0 are fine). Some versions are pinned on purpose (web-ifc, three, three-mesh-bvh, pdfjs-dist); read [Pinned versions](docs/development.md#pinned-versions) before upgrading them.

### Commit messages

Write commit messages that explain the change in the first line, with more detail in the body when needed. The history uses [gitmoji](https://gitmoji.dev) (`:bug: Fix storey elevations for linked models`); using it is welcome but not required.

## Licence of contributions

bim-os is released under the [MIT License](LICENSE). By submitting a contribution you agree that it is licensed under the same terms, and that you have the right to submit it.
