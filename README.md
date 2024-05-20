# README
## This is the README for your extension "generative-db"

**Follow these steps to configture the project.**

1) Install the [Azure Data Studio Debug Plugin](https://marketplace.visualstudio.com/items?itemName=ms-mssql.sqlops-debug)

2) Make sure to run ```npm i``` on the project root

3) To  configure the tool create a .env file in the root of the project with the following content:
    ```
   # .env
   DEBUG=true
   
   #Database Settings
   DB_HOSTNAME=""
   DB_PORT=1433
   DB_USERNAME=""
   DB_PASSWORD=""
   DB_CATALOG=""
   
   # Assistant Settings
   GPT_MODEL_VERSION="gpt-3.5-turbo-0125"
   GPT_TEMPERATURE=0
   
   # OpenAI Settings
   OPENAI_API_KEY=""
   
   # To use with Azure you should have AZURE_OPENAI_API_KEY, AZURE_OPENAI_API_INSTANCE_NAME, AZURE_OPENAI_API_DEPLOYMENT_NAME
   # and AZURE_OPENAI_API_VERSION environment variable set.AZURE_OPENAI_BASE_PATH is optional and will override AZURE_OPENAI_API_INSTANCE_NAME
   # AZURE_OPENAI_API_KEY=
   # AZURE_OPENAI_API_INSTANCE_NAME=
   # AZURE_OPENAI_API_DEPLOYMENT_NAME=
   # AZURE_OPENAI_API_VERSION=
   # AZURE_OPENAI_BASE_PATH=
   
   # Langchain/Langsmith
   LANGCHAIN_TRACING_V2=true
   LANGCHAIN_ENDPOINT=""
   LANGCHAIN_API_KEY=""
   LANGCHAIN_PROJECT=""
    ```