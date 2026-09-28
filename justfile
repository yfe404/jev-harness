default:
    just --list

install:
    npm ci

build:
    npm run build

test:
    npm test

check:
    npm run check

examples:
    npm run examples

pack:
    npm pack --dry-run

# Pack, install the tarball into an isolated prefix, and smoke-test it
smoke:
    npm run smoke
