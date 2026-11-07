import os

import uvicorn


if __name__ == '__main__':
    # Single HTTP worker and one supervised CPU child; do not use --reload.
    uvicorn.run('pdf_analysis.app:create_app', factory=True,
                host=os.environ.get('PDF_ANALYSIS_HOST', '127.0.0.1'),
                port=int(os.environ.get('PDF_ANALYSIS_PORT', '8091')),
                workers=1, access_log=False, log_level='warning')
