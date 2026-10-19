# Copyright (c) 2026 OpenNVR
# This file is part of OpenNVR.
#
# OpenNVR is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# OpenNVR is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU Affero General Public License
# along with OpenNVR.  If not, see <https://www.gnu.org/licenses/>.

"""add recording motion

Adds ``recordings.motion``: per-second motion activity for each recorded clip,
measured from the clip's keyframes by services/motion_index.py. Byte ``i`` is
second ``i`` of the clip, ``round(255 * sqrt(changed fraction))``. It drives
the motion bar on the playback timeline.

Nullable, no default: every existing clip starts unscored (NULL) and the
indexer backfills them, newest first. An empty value means the file could not
be read.

The partial index holds only the clips still waiting to be scored, so the
indexer's "what next" query stays cheap however large the archive grows.

Revision ID: b5e1d7c3a9f2
Revises: a7c3e9f1b2d4
Create Date: 2026-10-19 12:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "b5e1d7c3a9f2"
down_revision: str | None = "a7c3e9f1b2d4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "recordings",
        sa.Column(
            "motion",
            sa.LargeBinary(),
            nullable=True,
            comment=(
                "Per-second motion activity: byte i = second i of the clip, "
                "round(255*sqrt(changed fraction)). NULL = not scored yet, "
                "empty = unreadable file."
            ),
        ),
    )
    op.create_index(
        "ix_recordings_motion_pending",
        "recordings",
        ["start_time"],
        postgresql_where=sa.text("motion IS NULL"),
        sqlite_where=sa.text("motion IS NULL"),
    )


def downgrade() -> None:
    op.drop_index("ix_recordings_motion_pending", table_name="recordings")
    op.drop_column("recordings", "motion")
