# Security policy

## Supported versions

bim-os is before its 1.0 release. Security fixes are made on the `main` branch only; please make sure a problem still exists on the latest `main` before reporting it.

## Reporting a vulnerability

Please do not report security problems in public issues, pull requests or discussions.

Report them privately through GitHub: on the repository's **Security** tab choose **Report a vulnerability** ([direct link](https://github.com/khjabir/bim-os/security/advisories/new)). If that is not available, contact the repository owner, [khjabir](https://github.com/khjabir), through the email address on their GitHub profile.

A useful report says:

- what is affected (page, API route, command-line script or file type) and on which commit;
- how to reproduce it, step by step, with a proof of concept if you have one;
- what an attacker could achieve;
- if a crafted file triggers it, a minimal sample file. Never send real project models or other people's data.

The maintainers will acknowledge the report, investigate it, keep you informed, and agree a disclosure date with you once a fix is ready. You will be credited in the advisory unless you prefer not to be.

## Scope

In scope is the code in this repository, for example:

- reading untrusted files in the browser or on the command line: IFC, ifcZIP and other archives, Fragments, viewer extracts (`.eapk`), PDFs and images;
- the API routes `/api/assistant` and `/api/aps/*`, which hold the server-side keys;
- the viewer extractor (bookmarklet), which runs on Autodesk viewer pages and passes data back to bim-os;
- the files bim-os writes (IFC, Fragments, workbooks, diagrams).

Not in scope: problems in Autodesk's or Anthropic's services, and problems in third-party dependencies that bim-os does not make worse. Please report those to the projects concerned, and tell us if bim-os needs an update as a result.

## Things that are by design

- The API routes accept requests from the app's own pages only and have no user authentication. They are meant for running bim-os on your own machine: anyone who can reach a deployment can spend its API credit and cloud quota. Put authentication in front of them before hosting bim-os where others can reach it.
- Keys in `.env.local` are read by the server-side routes only and are never sent to the browser.
- Models opened in the IFC viewer, the in-browser Revit reader and the Convert page stay on your computer. Files leave it only through the routes you choose: Autodesk Platform Services for Revit and Navisworks, and the AI assistant, which sends your questions and the results of its tools (counts, names, property values) to Anthropic, but not the model file or its geometry.

## Good-faith research

We welcome good-faith security research. Test against your own installation, do not access data that is not yours, and do not degrade services for others.
