#!/bin/bash

set -e

yarn lint-staged
yarn dedupe --check
