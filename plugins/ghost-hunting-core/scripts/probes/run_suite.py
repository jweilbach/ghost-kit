"""Import-based suite runner for the /reckoning sql-per-request instrument.

    python run_suite.py <test args...>

Runs the test suite in-process with the sqlcount probe loaded (-p sqlcount; PYTHONPATH must
include this directory) and no cache provider, so no .pytest_cache lands in the tree.
Neither this file's name nor the resulting argv contains the runner's name, so a sibling
lane's `pkill -f <runner>` cannot match this process. Exits with the suite's own status.
"""

import sys

import pytest

if __name__ == "__main__":
    sys.exit(pytest.main([*sys.argv[1:], "-p", "no:cacheprovider", "-p", "sqlcount"]))
