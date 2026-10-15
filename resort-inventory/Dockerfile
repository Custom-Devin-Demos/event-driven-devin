FROM maven:3.8.8-eclipse-temurin-8 AS build
WORKDIR /src
COPY maven-settings.xml /root/.m2/settings.xml
COPY pom.xml .
RUN mvn -q -B dependency:go-offline
COPY src ./src
RUN mvn -q -B package -DskipTests

FROM eclipse-temurin:8-jre
WORKDIR /app
COPY --from=build /src/target/resort-inventory.jar app.jar
ENV JAVA_OPTS="-Xms64m -Xmx160m -XX:+UseSerialGC"
EXPOSE 8080
CMD ["sh", "-c", "exec java $JAVA_OPTS -jar app.jar"]
