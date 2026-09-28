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

pack:
    npm pack --dry-run
