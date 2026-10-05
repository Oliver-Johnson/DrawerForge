# Security

## What the attack surface actually is

Worth stating plainly, because it is unusually small: Drawerforge is a set of static
pages. There is no server, no database, no account, no session, no analytics and no
third-party script. Nothing you enter is transmitted anywhere — the geometry is
computed in your browser and the files are generated there.

A layout is carried in the URL fragment so a link can be shared. Fragments are not
sent to servers by browsers, and the layout holds only drawer dimensions and bin
settings. It contains nothing about you.

That leaves a short list of things that would count as a vulnerability here:

- a crafted layout link that executes script when opened (the URL is parsed by the page)
- a crafted layout link that makes the page hang or exhaust memory
- an exported STL or 3MF that could harm a slicer that opens it
- anything reaching the network, since nothing should

## Reporting

Please report privately rather than opening a public issue, using
[GitHub's private vulnerability reporting](https://github.com/Oliver-Johnson/DrawerForge/security/advisories/new)
on this repository.

Include what you did, what happened, and a layout link if one is involved. You will
get an acknowledgement, and credit in the fix unless you would rather not.

## Supported versions

The deployed site is the only supported version. It is built from `main` on every
push, so a fix reaches users as soon as it merges.
